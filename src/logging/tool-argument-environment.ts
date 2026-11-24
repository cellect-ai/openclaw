import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { isSensitiveFieldKey } from "./redact.js";

/** Execution keeps its environment; tool observers never acquire its credentials. */
export function projectToolArgumentEnvironment(args: unknown): unknown {
  const record = asOptionalRecord(args);
  const env = asOptionalRecord(record?.env);
  if (!record || !env) return args;
  const keys = Object.keys(env).filter((key) => isSensitiveFieldKey(key) && env[key] !== undefined);
  if (!keys.length) return args;
  const projected = { ...env };
  for (const key of keys) projected[key] = "[redacted]";
  return { ...record, env: projected };
}
