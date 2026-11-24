export type MatrixTurnOrigin =
  | { eventId: string; mode: "text" }
  | { threadRootEventId: string; mode: "voice" };

export function sessionThreadId(sessionKey: string): string | undefined {
  const marker = ":thread:";
  const at = sessionKey.lastIndexOf(marker);
  if (at < 0) {
    return undefined;
  }
  const id = sessionKey.slice(at + marker.length);
  return id.length > 0 ? id : undefined;
}

/**
 * Threaded text and Talk consults keep the bare Matrix room on channel context,
 * while the hook chat id can be the session raw id (`!room:server:thread:$root`).
 * Accept its suffix only when it matches the host-owned session (or Talk root).
 */
export function hostChatMatchesRoom(chatId: unknown, roomId: string, threadRoot: unknown): boolean {
  if (typeof chatId !== "string" || chatId.length === 0) {
    return false;
  }
  if (chatId === roomId) {
    return true;
  }
  if (typeof threadRoot !== "string" || !threadRoot.startsWith("$")) {
    return false;
  }
  const marker = ":thread:";
  const at = chatId.lastIndexOf(marker);
  return (
    at > 0 && chatId.slice(0, at) === roomId && chatId.slice(at + marker.length) === threadRoot
  );
}

export function turnIds(turn: MatrixTurnOrigin): {
  eventId: string | null;
  threadRootEventId: string | null;
} {
  return turn.mode === "voice"
    ? { eventId: null, threadRootEventId: turn.threadRootEventId }
    : { eventId: turn.eventId, threadRootEventId: null };
}

export function logEntitlements(fields: Record<string, unknown>, mismatch?: string): void {
  const line = {
    evt: "threads.agent_entitlements",
    ...fields,
    ...(mismatch ? { mismatch } : {}),
  };
  console.info(JSON.stringify(line));
  if (mismatch) {
    console.warn(JSON.stringify({ ...line, level: "warn" }));
  }
}
