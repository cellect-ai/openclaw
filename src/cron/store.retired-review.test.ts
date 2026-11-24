import { expect, it } from "vitest";
import { prepareCronOwnerWriteRefusal } from "../config/io.cron-owner-refusal.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { saveCronJobsStore } from "./store.js";
import { createReloadCronJob } from "./store.test-support.js";
import { withCronStore, writeCronJobScratch } from "./store.worker.test-support.js";
import { cronStoreKey } from "./store/key.js";

const job = (id: string) => createReloadCronJob({ id, agentId: "main" });

const legacyReview = {
  ...job("retired"),
  payload: { kind: "skillCollectionReview" },
};
const curator = {
  ...job("retired"),
  payload: { kind: "agentTurn", message: "Weekly Skill Workshop curator pass." },
};

it.each([
  ["json-only", "systemEvent", legacyReview, null],
  ["column-only", "skillCollectionReview", job("retired"), null],
  ["curator", "agentTurn", curator, "skill-collection-review:main"],
] as const)(
  "quarantines unrecognized %s legacy rows without deleting data",
  (_shape, kind, definition, declaration) =>
    withCronStore("retired-workshop-cron", async (state) => {
      const { storePath } = state;
      const otherStorePath = state.statePath("other-cron", "jobs.json");
      await state.save({ version: 1, jobs: [job("retired"), job("keep")] });
      await saveCronJobsStore(otherStorePath, { version: 1, jobs: [job("retired")] });
      for (const target of [storePath, otherStorePath]) {
        await writeCronJobScratch({
          storePath: target,
          jobId: "retired",
          content: "old scratch",
          nowMs: 1,
        });
      }
      const db = openOpenClawStateDatabase().db;
      const version = db.prepare("PRAGMA user_version").get();
      db.prepare(
        "UPDATE cron_jobs SET payload_kind = ?, job_json = ?, declaration_key = ? WHERE job_id = ?",
      ).run(kind, JSON.stringify(definition), declaration, "retired");
      const counts = (target: string) =>
        ["cron_jobs", "cron_job_scratch"].map((table) =>
          db
            .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE store_key = ? AND job_id = ?`)
            .get(cronStoreKey(target), "retired"),
        );

      const readOnly = await state.read();
      expect(readOnly.invalidConfigRows).toHaveLength(1);
      expect(readOnly.store.jobs.map((entry) => entry.id)).toEqual(["keep"]);
      expect(readOnly.configJobs.map((entry) => entry.id)).toEqual(["keep"]);
      await expect(prepareCronOwnerWriteRefusal({}, { storePath, env: state.env })).rejects.toThrow(
        "ownership cannot be verified",
      );
      expect(counts(storePath)).toEqual([{ count: 1 }, { count: 1 }]);
      expect((await state.load()).store.jobs.map((entry) => entry.id)).toEqual(["keep"]);
      expect(counts(storePath)).toEqual([{ count: 1 }, { count: 1 }]);
      expect(counts(otherStorePath)).toEqual([{ count: 1 }, { count: 1 }]);
      expect(db.prepare("PRAGMA user_version").get()).toEqual(version);
    }),
);

it("requires explicit repair of an unknown older payload before ownership-sensitive config writes", () =>
  withCronStore("unknown-workshop-doctor", async (state) => {
    await state.save({ version: 1, jobs: [job("retired")] });
    const db = openOpenClawStateDatabase().db;
    const json = JSON.stringify(legacyReview);
    db.prepare("UPDATE cron_jobs SET payload_kind = ?, job_json = ? WHERE job_id = ?").run(
      "skillCollectionReview",
      json,
      "retired",
    );
    await expect(
      prepareCronOwnerWriteRefusal({}, { storePath: state.storePath, env: state.env }),
    ).rejects.toThrow("ownership cannot be verified");
    await state.load();
    expect(db.prepare("SELECT job_json FROM cron_jobs WHERE job_id = ?").get("retired")).toEqual({
      job_json: json,
    });
  }));
