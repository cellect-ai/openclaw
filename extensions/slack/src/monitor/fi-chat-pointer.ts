/** Slack metadata so a later snapshot can drop this notice without matching prose. */
export const FI_CHAT_POINTER_EVENT = "cellect.fi_chat_pointer";

const FI_CHAT_PATH = /\/chat\/?$/i;

export type SlackPointerCandidate = {
  ts?: string;
  bot_id?: string;
  bot?: boolean;
  text?: string;
  metadata?: { event_type?: string };
};

/** A bot notice pointing at the Fi conversation, never a human paste of the same URL. */
export function isSlackFiChatPointer(message: SlackPointerCandidate): boolean {
  if (message.metadata?.event_type === FI_CHAT_POINTER_EVENT) {
    return true;
  }
  return Boolean(message.bot_id || message.bot) && isFiConversationChatUrl(message.text);
}

export function isFiConversationChatUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  for (const candidate of value.match(/https:\/\/[^\s>|]+/gi) ?? []) {
    try {
      const url = new URL(candidate.replace(/[).,]+$/, ""));
      if (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        FI_CHAT_PATH.test(url.pathname) &&
        /^[A-Za-z0-9._-]{8,80}$/.test(url.searchParams.get("fiConversation") ?? "")
      ) {
        return true;
      }
    } catch {
      // Ignore leftover punctuation that is not a URL.
    }
  }
  return false;
}

/**
 * True when a pointer is already the latest Slack activity: later source
 * messages (a file upload, a reply) need a fresh notice at the bottom.
 */
export function sourcePointerCoversLatest(messages: SlackPointerCandidate[]): boolean {
  let latestPointer: string | undefined;
  let latestOther: string | undefined;
  for (const message of messages) {
    if (!message.ts) {
      continue;
    }
    if (isSlackFiChatPointer(message)) {
      if (!latestPointer || message.ts.localeCompare(latestPointer) > 0) {
        latestPointer = message.ts;
      }
      continue;
    }
    if (!latestOther || message.ts.localeCompare(latestOther) > 0) {
      latestOther = message.ts;
    }
  }
  if (!latestPointer) {
    return false;
  }
  return !latestOther || latestOther.localeCompare(latestPointer) <= 0;
}

export function sourcePointerCoversProjected(
  latestPointerMessageId: string | undefined,
  messageIds: Iterable<string>,
): boolean {
  if (!latestPointerMessageId) {
    return false;
  }
  for (const id of messageIds) {
    if (id.localeCompare(latestPointerMessageId) > 0) {
      return false;
    }
  }
  return true;
}

export function fiChatPointerText(chatUrl: string): string | null {
  try {
    const url = new URL(chatUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !FI_CHAT_PATH.test(url.pathname) ||
      !/^[A-Za-z0-9._-]{8,80}$/.test(url.searchParams.get("fiConversation") ?? "")
    ) {
      return null;
    }
    return `This conversation continues in Fi: <${url.toString()}|Open in Fi>`;
  } catch {
    return null;
  }
}
