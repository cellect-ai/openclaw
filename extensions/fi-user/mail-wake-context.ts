/** This input is runtime-owned plugin context, never a tool/request body. A
 * mail run cannot ask for an ordinary member credential by omitting its source. */
export function mailWakeDelegationContext(context: {
  sessionKey?: string;
  hookSourceLockCapability?: string;
  hookMailWakeSessionKey?: string;
  hostMailWakeEnvironment?: "dev" | "staging" | "prod";
}): { sessionKey?: string; sourceLockCapability?: string } {
  const sessionKey = context.hookMailWakeSessionKey ?? context.sessionKey;
  if (!/(?:^|:)hook:fi-mail:/i.test(sessionKey ?? "")) return {};
  if (
    !/^agent:[^:\s]+:hook:fi-mail:[^:\s]+(?::run:\S+)?$/i.test(sessionKey ?? "") ||
    !/^slw:[^:\s]{1,200}:[A-Za-z0-9_-]{43}$/.test(context.hookSourceLockCapability ?? "") ||
    !["dev", "staging", "prod"].includes(context.hostMailWakeEnvironment ?? "")
  ) {
    throw new Error(
      "This mail wake has no current host source receipt; rebind the wake before requesting a Fi credential",
    );
  }
  return { sessionKey, sourceLockCapability: context.hookSourceLockCapability };
}
