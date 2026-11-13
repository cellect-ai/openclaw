/** Host-only source custody for one authenticated Fi mail hook. Fi verifies
 * the opaque receipt; this owner prevents another run/session borrowing it. */
const RECEIPT = /^slw:[^:\s]{1,200}:[A-Za-z0-9_-]{43}$/;
const RUN_SESSION = /^agent:[^:\s]+:hook:fi-mail:[^:\s]+(?::run:\S+)?$/i;
export function normalizeMailWakeSourceLock(
  payload: Record<string, unknown>,
  sessionKey: string | undefined,
): { ok: true; value: { sourceLockCapability?: string } } | { ok: false; error: string } {
  if (payload.sourceLockCapability === undefined) return { ok: true, value: {} };
  if (!sessionKey?.startsWith("hook:fi-mail:"))
    return { ok: false, error: "sourceLockCapability requires a hook:fi-mail: session" };
  const value = payload.sourceLockCapability;
  if (typeof value !== "string" || !RECEIPT.test(value.trim()))
    return { ok: false, error: "sourceLockCapability is not a wake receipt" };
  return { ok: true, value: { sourceLockCapability: value.trim() } };
}
const active = new Map<
  string,
  {
    sessionKey: string;
    capability: string | undefined;
    mailSessionKey: string;
    environment?: "dev" | "staging" | "prod";
  }
>();
export function registerMailWakeSourceLock(input: {
  runId: string;
  sessionKey: string;
  capability: string | undefined;
  /** Original authenticated mail hook target, before isolated cron projection. */
  mailSessionKey?: string;
  environment?: "dev" | "staging" | "prod";
}): () => void {
  const mailSessionKey = input.mailSessionKey ?? input.sessionKey;
  if (
    !input.runId ||
    !RUN_SESSION.test(mailSessionKey) ||
    (input.capability !== undefined && !RECEIPT.test(input.capability))
  )
    return () => {};
  if (active.size >= 512 && !active.has(input.runId)) {
    throw new Error("Mail source custody capacity reached; refusing a new unbound run");
  }
  const entry = {
    sessionKey: input.sessionKey.toLowerCase(),
    capability: input.capability,
    mailSessionKey,
    environment: input.environment,
  };
  active.set(input.runId, entry);
  return () => {
    if (active.get(input.runId) === entry) active.delete(input.runId);
  };
}
export function lookupMailWakeSourceLock(
  runId: string | undefined,
  sessionKey: string | undefined,
): string | undefined {
  if (!runId || !sessionKey) {
    return undefined;
  }
  const entry = active.get(runId);
  return entry?.sessionKey === sessionKey.toLowerCase() ? entry.capability : undefined;
}

/** Logical source target follows the same actual run/session custody. */
export function lookupMailWakeSessionKey(
  runId: string | undefined,
  sessionKey: string | undefined,
): string | undefined {
  if (!runId || !sessionKey) {
    return undefined;
  }
  const entry = active.get(runId);
  return entry?.sessionKey === sessionKey.toLowerCase() ? entry.mailSessionKey : undefined;
}

export function lookupMailWakeEnvironment(
  runId: string | undefined,
  sessionKey: string | undefined,
): "dev" | "staging" | "prod" | undefined {
  if (!runId || !sessionKey) {
    return undefined;
  }
  const entry = active.get(runId);
  return entry?.sessionKey === sessionKey.toLowerCase() ? entry.environment : undefined;
}
