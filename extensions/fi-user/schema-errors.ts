import type { TSchema } from "typebox";
import { Value } from "typebox/value";

const MAX_ECHO_CHARS = 80;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The value at a JSON pointer (`/range/rows`), or undefined. */
function valueAt(value: unknown, pointer: string): unknown {
  let current = value;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      current = current[Number(key)];
    } else if (isRecord(current)) {
      current = current[key];
    } else {
      return undefined;
    }
  }
  return current;
}

function echo(value: unknown): string {
  let text: string;
  try {
    text =
      typeof value === "string" ? JSON.stringify(value) : (JSON.stringify(value) ?? String(value));
  } catch {
    text = String(value);
  }
  return text.length > MAX_ECHO_CHARS ? `${text.slice(0, MAX_ECHO_CHARS)}…` : text;
}

/**
 * The first validation error of `value` against `schema`, as
 * `<field>: <message>` plus the rejected value (at most 80 characters) or
 * "missing". A tool that says only "invalid request" leaves the model to guess
 * which of its fields was wrong, and it retries the same call.
 */
export function firstSchemaError(schema: TSchema, value: unknown): string | undefined {
  const [error] = [...Value.Errors(schema, value)] as Array<{
    instancePath?: string;
    keyword?: string;
    message?: string;
    params?: { requiredProperties?: string[]; additionalProperties?: string[] };
  }>;
  if (!error) {
    return undefined;
  }
  const pointer = error.instancePath ?? "";
  const path = pointer.split("/").slice(1).join(".");
  const required = error.keyword === "required" ? error.params?.requiredProperties?.[0] : undefined;
  if (required) {
    return `${path ? `${path}.` : ""}${required}: required, missing`;
  }
  const extra =
    error.keyword === "additionalProperties" ? error.params?.additionalProperties?.[0] : undefined;
  if (extra) {
    return `${path ? `${path}.` : ""}${extra}: not an accepted field`;
  }
  return `${path || "request"}: ${error.message ?? "invalid"} (got ${echo(valueAt(value, pointer))})`;
}

/** For a union of `action`-tagged objects: the branch the call names, else the union. */
export function actionBranch(
  branches: readonly TSchema[],
  union: TSchema,
  value: unknown,
): TSchema {
  const action = isRecord(value) ? value.action : undefined;
  return (
    branches.find(
      (branch) =>
        isRecord((branch as { properties?: unknown }).properties) &&
        (branch as { properties: Record<string, { const?: unknown }> }).properties.action?.const ===
          action,
    ) ?? union
  );
}
