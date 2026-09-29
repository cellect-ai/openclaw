import type { WebClient } from "@slack/web-api";

const NAME_REFRESH_MS = 6 * 60 * 60 * 1000;
const MAX_CACHED_NAMES = 5_000;
// Last known Slack name per workspace actor. A snapshot's rendered text is
// hashed downstream, so a name that disappears whenever users.info is rate
// limited would republish every message on the next sweep.
const knownNames = new Map<string, { name: string; resolvedAt: number }>();

/** Test seam: forget cached names. */
export function resetSlackProjectionNameCache(): void {
  knownNames.clear();
}

/** Names are presentation facts from Slack, never identity or grant evidence. */
export async function hydrateSlackProjectionNames<T extends { senderId: string }>(
  client: WebClient,
  workspaceId: string,
  messages: T[],
  read: <R>(operation: () => Promise<R>) => Promise<R>,
): Promise<Array<T & { displayName?: string }>> {
  const names = new Map<string, string>();
  // Bound optional profile work independently of message history. A missing
  // profile/scope leaves a neutral actor label; it never changes source access.
  for (const senderId of [...new Set(messages.map((message) => message.senderId))].slice(0, 100)) {
    const key = `${workspaceId}:${senderId}`;
    const known = knownNames.get(key);
    if (known && Date.now() - known.resolvedAt < NAME_REFRESH_MS) {
      names.set(senderId, known.name);
      continue;
    }
    try {
      const result = await read(() => client.users.info({ user: senderId }));
      if (result.ok && result.user?.id === senderId && result.user.team_id === workspaceId) {
        const name = result.user.profile?.display_name?.trim() || result.user.real_name?.trim();
        if (name) {
          const clean = Array.from(name, (character) => {
            const code = character.codePointAt(0) ?? 0;
            return code <= 0x1f || code === 0x7f ? " " : character;
          })
            .join("")
            .slice(0, 160);
          if (knownNames.size >= MAX_CACHED_NAMES && !knownNames.has(key)) {
            knownNames.delete(knownNames.keys().next().value!);
          }
          knownNames.set(key, { name: clean, resolvedAt: Date.now() });
          names.set(senderId, clean);
          continue;
        }
      }
    } catch {
      // Optional source names cannot turn a complete roster into an access denial.
    }
    // A failed refresh keeps the last name Slack gave for this actor.
    if (known) {
      names.set(senderId, known.name);
    }
  }
  return messages.map((message) => ({
    ...message,
    ...(names.has(message.senderId) ? { displayName: names.get(message.senderId) } : {}),
  }));
}
