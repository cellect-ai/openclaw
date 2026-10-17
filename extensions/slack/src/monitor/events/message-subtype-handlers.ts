import {
  truncateSanitizedExternalContent,
  wrapExternalContent,
} from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeSlackThreadTsCandidate } from "../../thread-ts.js";
import { resolveSlackThreadContext } from "../../threading.js";
import type { SlackMessageEvent } from "../../types.js";
import { resolveSlackMessageText } from "../block-text.js";
import type { SlackMessageChangedEvent, SlackMessageDeletedEvent } from "../types.js";

type SupportedSubtype = "message_changed" | "message_deleted";

type SlackMessageSubtypeHandler = {
  eventKind: SupportedSubtype;
  describe: (channelLabel: string, event: SlackMessageEvent) => string;
  resolveMessageTs: (event: SlackMessageEvent) => string | undefined;
  contextKey: (event: SlackMessageEvent) => string;
  resolveSenderId: (event: SlackMessageEvent) => string | undefined;
  resolveThreadTs: (event: SlackMessageEvent) => string | undefined;
};

function resolveNestedThreadTs(event: SlackMessageEvent): string | undefined {
  const changed = event as SlackMessageChangedEvent;
  const message = changed.message?.thread_ts ? changed.message : changed.previous_message;
  if (!message) {
    return undefined;
  }
  return normalizeSlackThreadTsCandidate(
    resolveSlackThreadContext({
      message: { type: "message", channel: event.channel, ...message },
      replyToMode: "off",
    }).replyToId,
  );
}

function describeMessageChange(
  channelLabel: string,
  event: SlackMessageEvent,
  deleted: boolean,
): string {
  const handler = deleted ? deletedHandler : changedHandler;
  const current = (event as SlackMessageChangedEvent).message;
  const text =
    !deleted && current
      ? resolveSlackMessageText(
          {
            text: typeof current.text === "string" ? current.text : undefined,
            blocks: Array.isArray(current.blocks) ? current.blocks : undefined,
            attachments: Array.isArray(current.attachments)
              ? current.attachments
                  .filter((item) => item && typeof item === "object")
                  .map((item) => ({
                    is_msg_unfurl: item.is_msg_unfurl,
                    is_app_unfurl: item.is_app_unfurl,
                    app_unfurl_url: item.app_unfurl_url,
                    blocks: Array.isArray(item.blocks) ? item.blocks : undefined,
                  }))
              : undefined,
          },
          { preserveMessageTextWhitespace: true },
        )
      : undefined;
  const bounded = text === undefined ? undefined : truncateSanitizedExternalContent(text, 4000);
  // Original author is not necessarily the person who edited or deleted it.
  // Quote current content as external data; never carry the previous/deleted body.
  const context = {
    channelId: event.channel,
    messageTs: handler.resolveMessageTs(event) ?? null,
    threadTs: handler.resolveThreadTs(event) ?? null,
    originalAuthorId: handler.resolveSenderId(event) ?? null,
    ...(!deleted
      ? { currentText: bounded?.text ?? null, textTruncated: bounded?.truncated ?? false }
      : {}),
  };
  return [
    `Slack message ${deleted ? "deleted" : "edited"} in ${channelLabel}.`,
    "Next-turn context only, not a new request. Message IDs identify the affected source; null means unknown. Truncated or unavailable content requires rereading the source.",
    wrapExternalContent(JSON.stringify(context), { source: "api", includeWarning: false }),
  ].join("\n");
}

const changedHandler: SlackMessageSubtypeHandler = {
  eventKind: "message_changed",
  describe: (channelLabel, event) => describeMessageChange(channelLabel, event, false),
  resolveMessageTs: (event) => {
    const changed = event as SlackMessageChangedEvent;
    return (
      normalizeSlackThreadTsCandidate(changed.message?.ts) ??
      normalizeSlackThreadTsCandidate(changed.previous_message?.ts)
    );
  },
  contextKey: (event) => {
    const changed = event as SlackMessageChangedEvent;
    const channelId = changed.channel ?? "unknown";
    const messageId =
      changed.message?.ts ?? changed.previous_message?.ts ?? changed.event_ts ?? "unknown";
    return `slack:message:changed:${channelId}:${messageId}`;
  },
  resolveSenderId: (event) => {
    const changed = event as SlackMessageChangedEvent;
    return (
      normalizeOptionalString(changed.message?.user) ??
      normalizeOptionalString(changed.previous_message?.user) ??
      normalizeOptionalString(changed.message?.bot_id) ??
      normalizeOptionalString(changed.previous_message?.bot_id)
    );
  },
  resolveThreadTs: resolveNestedThreadTs,
};

const deletedHandler: SlackMessageSubtypeHandler = {
  eventKind: "message_deleted",
  describe: (channelLabel, event) => describeMessageChange(channelLabel, event, true),
  resolveMessageTs: (event) => {
    const deleted = event as SlackMessageDeletedEvent;
    return (
      normalizeSlackThreadTsCandidate(deleted.deleted_ts) ??
      normalizeSlackThreadTsCandidate(deleted.previous_message?.ts)
    );
  },
  contextKey: (event) => {
    const deleted = event as SlackMessageDeletedEvent;
    const channelId = deleted.channel ?? "unknown";
    const messageId = deleted.deleted_ts ?? deleted.event_ts ?? "unknown";
    return `slack:message:deleted:${channelId}:${messageId}`;
  },
  resolveSenderId: (event) => {
    const deleted = event as SlackMessageDeletedEvent;
    return (
      normalizeOptionalString(deleted.previous_message?.user) ??
      normalizeOptionalString(deleted.previous_message?.bot_id)
    );
  },
  resolveThreadTs: resolveNestedThreadTs,
};

const SUBTYPE_HANDLER_REGISTRY: Record<SupportedSubtype, SlackMessageSubtypeHandler> = {
  message_changed: changedHandler,
  message_deleted: deletedHandler,
};

export function resolveSlackMessageSubtypeHandler(
  event: SlackMessageEvent,
): SlackMessageSubtypeHandler | undefined {
  const subtype = event.subtype;
  if (subtype !== "message_changed" && subtype !== "message_deleted") {
    return undefined;
  }
  return SUBTYPE_HANDLER_REGISTRY[subtype];
}
