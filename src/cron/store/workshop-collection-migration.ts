/** Stable-tag weekly declarations migrate through the cron writer, preserving runtime history. */
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { WORKSHOP_COLLECTION_REVIEW_MESSAGE } from "../../skills/workshop-host/collection-review-prompt.js";
import {
  RETIRED_SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX,
  WORKSHOP_COLLECTION_REVIEW_DECLARATION_PREFIX,
} from "../system-owned-declaration.js";
import type { CronStoredJob } from "../types.js";
import { rowToCronJob } from "./row-codec.js";
import type { CronJobReadRow } from "./schema.js";

// Exact producer from fork 97613fcbbaf3d215e21939a40bbbe0d7135b5473 maintenance-prompt.ts.
const LEGACY_PROMPT_SHA256 = "73ff56de2590636d9dd52ead7a149052cd928f4b5b7462864e2b4c07047e48fe";
const LEGACY_TOOLS = ["ls", "read", "write", "edit", "apply_patch", "exec", "process"];
const WEEK_MS = 7 * 24 * 60 * 60_000;
const LEGACY_JOB_FIELDS = new Set([
  "id",
  "agentId",
  "declarationKey",
  "name",
  "displayName",
  "enabled",
  "createdAtMs",
  "updatedAtMs",
  "schedule",
  "sessionTarget",
  "wakeMode",
  "payload",
  "delivery",
  "state",
  "scheduledToolPolicy",
]);
function onlyFields(record: Record<string, unknown>, fields: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => fields.has(key));
}
function hasLegacyDeclaration(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.startsWith(RETIRED_SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX)
  );
}

export function isLegacyWorkshopCollectionRow(row: CronJobReadRow): boolean {
  const job = safeParseJsonRecord(row.job_json);
  return (
    row.payload_kind === "skillCollectionReview" ||
    asRecord(job?.payload).kind === "skillCollectionReview" ||
    hasLegacyDeclaration(row.declaration_key) ||
    hasLegacyDeclaration(job?.declarationKey)
  );
}

/** Unknown older payloads and look-alikes retain their stored bytes for explicit repair. */
export function migrateWorkshopCollectionRow(row: CronJobReadRow): CronStoredJob | null {
  const job = safeParseJsonRecord(row.job_json);
  if (!job) return null;
  const agentId = job.agentId;
  const key =
    typeof agentId === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(agentId)
      ? `${RETIRED_SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX}${agentId}`
      : undefined;
  const payload = asRecord(job.payload),
    schedule = asRecord(job.schedule),
    delivery = asRecord(job.delivery);
  // The pinned producer's native createJob stamps only this closed trusted
  // policy by default. Account/creator/exec/inference authority is not its output.
  const policy = asRecord(job.scheduledToolPolicy);
  if (
    !key ||
    !onlyFields(job, LEGACY_JOB_FIELDS) ||
    !onlyFields(payload, new Set(["kind", "message", "toolsAllow"])) ||
    !onlyFields(schedule, new Set(["kind", "everyMs", "anchorMs"])) ||
    !onlyFields(delivery, new Set(["mode"])) ||
    (job.scheduledToolPolicy !== undefined &&
      (policy.version !== 1 ||
        policy.mode !== "trusted" ||
        !onlyFields(policy, new Set(["version", "mode"])))) ||
    job.id !== row.job_id ||
    typeof job.enabled !== "boolean" ||
    Number(row.enabled) !== Number(job.enabled) ||
    job.declarationKey !== key ||
    row.declaration_key !== key ||
    row.agent_id !== agentId ||
    job.name !== `skill-collection-review-${agentId}` ||
    row.name !== job.name ||
    row.payload_kind !== "agentTurn" ||
    payload.kind !== "agentTurn" ||
    typeof payload.message !== "string" ||
    sha256Hex(payload.message) !== LEGACY_PROMPT_SHA256 ||
    JSON.stringify(payload.toolsAllow) !== JSON.stringify(LEGACY_TOOLS) ||
    schedule.kind !== "every" ||
    schedule.everyMs !== WEEK_MS ||
    job.sessionTarget !== "isolated" ||
    job.wakeMode !== "next-heartbeat" ||
    delivery.mode !== "none" ||
    job.owner !== undefined ||
    job.operatorSource !== undefined ||
    job.pluginCommand !== undefined
  )
    return null;
  return rowToCronJob(row, {
    ...job,
    declarationKey: `${WORKSHOP_COLLECTION_REVIEW_DECLARATION_PREFIX}${agentId}`,
    payload: {
      ...payload,
      kind: "agentTurn",
      message: WORKSHOP_COLLECTION_REVIEW_MESSAGE,
      toolsAllow: ["skill_workshop"],
      lightContext: true,
      timeoutSeconds: 120,
    },
    idleOnly: true,
  });
}

/** Quarantine only the read projection. Never erase unrecognized legacy data or run its old prompt. */
export function quarantineLegacyWorkshopRow(row: CronJobReadRow): CronJobReadRow {
  const job = safeParseJsonRecord(row.job_json);
  if (!job) return row;
  return {
    ...row,
    payload_kind: "retiredSkillCollectionReview",
    job_json: JSON.stringify({
      ...job,
      enabled: false,
      payload: { kind: "retiredSkillCollectionReview" },
    }),
  };
}
