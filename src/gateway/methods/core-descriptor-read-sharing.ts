import { PROFILE_STARTUP } from "./core-descriptor-options.js";
import { cronListShareKey, modelsListShareKey, operatorReadShareKey } from "./read-share-keys.js";

export const MODEL_METADATA_READ = {
  ...PROFILE_STARTUP,
  shareKey: modelsListShareKey,
  shareMaxAgeMs: 1_000,
  shareInvalidationEvents: ["chat.metadata.changed", "sessions.changed"],
} as const;

export const CRON_LIST_READ = {
  shareKey: cronListShareKey,
  shareMaxAgeMs: 1_000,
  shareInvalidationEvents: ["cron", "sessions.changed"],
} as const;

export const CRON_STATUS_READ = {
  shareKey: operatorReadShareKey,
  shareMaxAgeMs: 1_000,
  shareInvalidationEvents: ["cron"],
} as const;
