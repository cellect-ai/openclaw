/**
 * Join-key stdout for Matrix Talk bind → session → consult.
 * Never includes binding tokens, session capsules, or message bodies.
 */

export type TalkJoinEvent = "talk.binding_resolve" | "talk.session_create" | "talk.consult";

export function sessionThreadIdFromKey(sessionKey: string | undefined | null): string | undefined {
  const marker = ":thread:";
  const key = sessionKey ?? "";
  const at = key.lastIndexOf(marker);
  if (at < 0) {
    return undefined;
  }
  const id = key.slice(at + marker.length);
  return id.length > 0 ? id : undefined;
}

export function talkClientJoin(
  client: {
    pairedClientId?: string;
    connect?: { client?: { id?: string; mode?: string } };
  } | null,
): { client: string | null; clientMode: string | null } {
  return {
    client: client?.connect?.client?.id ?? client?.pairedClientId ?? null,
    clientMode: client?.connect?.client?.mode ?? null,
  };
}

export function logTalkJoin(
  evt: TalkJoinEvent,
  fields: Record<string, unknown>,
  mismatch?: string,
): void {
  const line = {
    evt,
    ...fields,
    ...(mismatch ? { mismatch } : {}),
  };
  console.info(JSON.stringify(line));
  if (mismatch) {
    console.warn(JSON.stringify({ ...line, level: "warn" }));
  }
}
