/** Slack metadata so a later snapshot can drop this notice without matching prose. */
export const FI_CHAT_POINTER_EVENT = "cellect_fi_chat_pointer";

const FI_CHAT_PATH = /\/chat\/?$/i;

export type SlackPointerCandidate = {
  ts?: string;
  bot_id?: string;
  bot?: boolean;
  user?: string;
  text?: string;
  metadata?: { event_type?: string; event_payload?: Record<string, unknown> };
};

/** A bot notice pointing at the Fi conversation, never a human paste of the same URL. */
export function isSlackFiChatPointer(message: SlackPointerCandidate): boolean {
  if (
    message.metadata?.event_type === FI_CHAT_POINTER_EVENT ||
    message.metadata?.event_type === "cellect.fi_chat_pointer"
  ) {
    return true;
  }
  return (
    Boolean(message.bot_id || message.bot) &&
    /^(?:This conversation continues in Fi: <https:\/\/[^\s>|]+\|Open in Fi>|New messages in Cellect · <https:\/\/[^\s>|]+\|Open in Cellect>)$/.test(
      message.text ?? "",
    ) &&
    isFiConversationChatUrl(message.text)
  );
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
    return `New messages in Cellect · <${url.toString()}|Open in Cellect>`;
  } catch {
    return null;
  }
}
