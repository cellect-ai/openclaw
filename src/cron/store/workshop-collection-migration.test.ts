import { expect, it } from "vitest";
import { WORKSHOP_COLLECTION_REVIEW_MESSAGE } from "../../skills/workshop-host/collection-review-prompt.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createReloadCronJob } from "../store.test-support.js";
import { withCronStore, writeCronJobScratch } from "../store.worker.test-support.js";
import { cronStoreKey } from "./key.js";
import { recordCronRun } from "./run-history.js";
import {
  claimCronRunReceiptForTest,
  finishCronRunReceiptAsync,
} from "./run-receipt-store.test-support.js";
import {
  LEGACY_WORKSHOP_REVIEW_MESSAGE,
  LEGACY_WORKSHOP_REVIEW_TOOLS,
} from "./workshop-collection-migration.test-support.js";

const legacyJob = () =>
  createReloadCronJob({
    id: "original-weekly",
    agentId: "main",
    name: "skill-collection-review-main",
    declarationKey: "skill-collection-review:main",
    enabled: false,
    schedule: { kind: "every", everyMs: 604800000, anchorMs: 4321 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "agentTurn",
      message: LEGACY_WORKSHOP_REVIEW_MESSAGE,
      toolsAllow: [...LEGACY_WORKSHOP_REVIEW_TOOLS],
    },
    delivery: { mode: "none" },
    state: { lastRunAtMs: 1234, lastRunStatus: "ok", nextRunAtMs: 604804321 },
  });

it("migrates the exact released declaration in place once with history, receipt and scratch intact", () =>
  withCronStore("workshop-preserve", async (state) => {
    const original = legacyJob();
    await state.save({ version: 1, jobs: [original] });
    await writeCronJobScratch({
      storePath: state.storePath,
      jobId: original.id,
      content: "retained scratch",
      nowMs: 1,
    });
    const receipt = claimCronRunReceiptForTest(state.storePath, original, 1000);
    await finishCronRunReceiptAsync({ handle: receipt, status: "ok", finishedAtMs: 1100 });
    await recordCronRun({
      storeKey: cronStoreKey(state.storePath),
      jobId: original.id,
      runId: "prior-run",
      agentId: "main",
      startedAt: 1000,
      endedAt: 1100,
      status: "ok",
      detail: { summary: "prior review" },
    });
    const db = openOpenClawStateDatabase().db;
    const activeReceipt = claimCronRunReceiptForTest(state.storePath, original, 1200);
    const rawState = `{ "lastStatus": "ok", "runningAtMs": 1200, "runningReceiptId": ${JSON.stringify(activeReceipt.receiptId)}, "nextRunAtMs": 604804321 }`;
    db.prepare(
      "UPDATE cron_jobs SET state_json = ?, runtime_updated_at_ms = 17 WHERE job_id = ?",
    ).run(rawState, original.id);
    const family = () => ({
      runtime: db
        .prepare("SELECT state_json, runtime_updated_at_ms FROM cron_jobs WHERE job_id = ?")
        .get(original.id),
      scratch: db.prepare("SELECT * FROM cron_job_scratch WHERE job_id = ?").all(original.id),
      receipts: db.prepare("SELECT * FROM cron_run_receipts WHERE job_id = ?").all(original.id),
      history: db.prepare("SELECT * FROM task_runs").all(),
    });
    const before = family();
    const preview = await state.read();
    expect(preview.store.jobs[0]).toMatchObject({
      id: original.id,
      declarationKey: "workshop-collection-review:main",
      enabled: false,
      schedule: original.schedule,
    });
    expect(
      db.prepare("SELECT declaration_key FROM cron_jobs WHERE job_id = ?").get(original.id),
    ).toEqual({ declaration_key: "skill-collection-review:main" });
    const loaded = await state.load();
    expect(loaded.invalidConfigRows).toEqual([]);
    expect(loaded.store.jobs).toHaveLength(1);
    expect(loaded.store.jobs[0]).toMatchObject({
      id: original.id,
      declarationKey: "workshop-collection-review:main",
      enabled: false,
      schedule: original.schedule,
      payload: { message: WORKSHOP_COLLECTION_REVIEW_MESSAGE, toolsAllow: ["skill_workshop"] },
    });
    expect(family()).toEqual(before);
    const row = db.prepare("SELECT * FROM cron_jobs WHERE job_id = ?").get(original.id);
    await state.load();
    expect(db.prepare("SELECT * FROM cron_jobs WHERE job_id = ?").get(original.id)).toEqual(row);
  }));

it.each(["changed-message", "mismatched-agent", "malformed-json", "duplicate"] as const)(
  "does not grant a runnable declaration to %s",
  (kind) =>
    withCronStore(`workshop-${kind}`, async (state) => {
      const old = legacyJob();
      await state.save({
        version: 1,
        jobs: [
          old,
          ...(kind === "duplicate"
            ? [
                {
                  ...old,
                  id: "already-migrated",
                  declarationKey: "workshop-collection-review:main",
                  payload: {
                    kind: "agentTurn" as const,
                    message: WORKSHOP_COLLECTION_REVIEW_MESSAGE,
                    toolsAllow: ["skill_workshop"],
                  },
                },
              ]
            : []),
        ],
      });
      const db = openOpenClawStateDatabase().db;
      if (kind === "changed-message")
        db.prepare(
          "UPDATE cron_jobs SET job_json = json_set(job_json, '$.payload.message', 'arbitrary') WHERE job_id = ?",
        ).run(old.id);
      if (kind === "mismatched-agent")
        db.prepare("UPDATE cron_jobs SET agent_id = 'other' WHERE job_id = ?").run(old.id);
      if (kind === "malformed-json")
        db.prepare("UPDATE cron_jobs SET job_json = '{' WHERE job_id = ?").run(old.id);
      const before = db.prepare("SELECT * FROM cron_jobs WHERE job_id = ?").get(old.id);
      const loaded = await state.load();
      expect(loaded.store.jobs.map((job) => job.id)).toEqual(
        kind === "duplicate" ? ["already-migrated"] : [],
      );
      expect(loaded.invalidConfigRows).toHaveLength(1);
      expect(db.prepare("SELECT * FROM cron_jobs WHERE job_id = ?").get(old.id)).toEqual(before);
    }),
);

const unsupportedLegacyFields = [
  ["$.sourceConversation", { sessionKey: "agent:other:main" }],
  ["$.createdActor", { type: "human", id: "other" }],
  ["$.owner", { agentId: "other" }],
  ["$.operatorSource", { kind: "operator" }],
  ["$.pluginCommand", { command: "arbitrary" }],
  ["$.toolsAllowProvenance", { version: 1, source: "final-executable-surface" }],
  [
    "$.scheduledToolPolicy",
    { version: 1, mode: "account", ownerSessionKey: "other", ownerAccountId: "other" },
  ],
  ["$.scheduledToolPolicy", { version: 1, mode: "trusted", callerOrigin: "injected" }],
  ["$.inferenceBinding", { version: 1, provider: "other" }],
  ["$.toolsAllowExecTarget", { host: "gateway" }],
  ["$.toolsAllowExecTargetRequirement", { version: 1, target: { host: "gateway" }, grantIndex: 5 }],
  ["$.runtimeAuthority", { version: 1, kind: "injected" }],
  ["$.sessionKey", "agent:other:main"],
  ["$.wakeMode", "now"],
  ["$.payload.model", "other/model"],
  ["$.payload.toolsAllowIsDefault", true],
  ["$.payload.allowUnsafeExternalContent", true],
  ["$.payload.futureExecutionOption", { enabled: true }],
  ["$.delivery.to", "other-recipient"],
  ["$.delivery.failureDestination", { to: "other-recipient" }],
  ["$.schedule.futureExecutionOption", true],
  ["$.futureExecutionAuthority", { enabled: true }],
] as const;

it.each(unsupportedLegacyFields)(
  "quarantines legacy execution-bearing extra %s without changing stored bytes",
  (jsonPath, value) =>
    withCronStore("workshop-extra-field", async (state) => {
      const old = legacyJob();
      await state.save({ version: 1, jobs: [old] });
      const db = openOpenClawStateDatabase().db;
      db.prepare(
        "UPDATE cron_jobs SET job_json = json_set(job_json, ?, json(?)) WHERE job_id = ?",
      ).run(jsonPath, JSON.stringify(value), old.id);
      const before = db.prepare("SELECT * FROM cron_jobs WHERE job_id = ?").get(old.id);
      for (const load of [state.read, state.load]) {
        const loaded = await load();
        expect(loaded.store.jobs).toEqual([]);
        expect(loaded.invalidConfigRows).toHaveLength(1);
        expect(db.prepare("SELECT * FROM cron_jobs WHERE job_id = ?").get(old.id)).toEqual(before);
      }
    }),
);

it.each(["sql-key", "json-key"] as const)(
  "detects the legacy declaration independently when the %s disagrees",
  (field) =>
    withCronStore(`workshop-${field}-mismatch`, async (state) => {
      const old = legacyJob();
      await state.save({ version: 1, jobs: [old] });
      const db = openOpenClawStateDatabase().db;
      if (field === "sql-key") {
        db.prepare("UPDATE cron_jobs SET declaration_key = 'ordinary:other' WHERE job_id = ?").run(
          old.id,
        );
      } else {
        db.prepare(
          "UPDATE cron_jobs SET job_json = json_set(job_json, '$.declarationKey', 'ordinary:other') WHERE job_id = ?",
        ).run(old.id);
      }
      const before = db.prepare("SELECT * FROM cron_jobs WHERE job_id = ?").get(old.id);
      for (const load of [state.read, state.load]) {
        const loaded = await load();
        expect(loaded.store.jobs).toEqual([]);
        expect(loaded.invalidConfigRows).toHaveLength(1);
        expect(db.prepare("SELECT * FROM cron_jobs WHERE job_id = ?").get(old.id)).toEqual(before);
      }
    }),
);

it("accepts only the exact trusted policy stamped by the pinned native producer", () =>
  withCronStore("workshop-native-trusted-policy", async (state) => {
    const original = {
      ...legacyJob(),
      scheduledToolPolicy: { version: 1 as const, mode: "trusted" as const },
    };
    await state.save({ version: 1, jobs: [original] });
    const loaded = await state.load();
    expect(loaded.invalidConfigRows).toEqual([]);
    expect(loaded.store.jobs).toHaveLength(1);
    expect(loaded.store.jobs[0]).toMatchObject({
      id: original.id,
      declarationKey: "workshop-collection-review:main",
      scheduledToolPolicy: { version: 1, mode: "trusted" },
      schedule: original.schedule,
      enabled: false,
    });
  }));
