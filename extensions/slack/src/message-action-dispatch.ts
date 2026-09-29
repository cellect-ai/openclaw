import { normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { readBooleanParam } from "openclaw/plugin-sdk/boolean-param";
import { resolveReactionMessageId } from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import {
  normalizeLegacyInteractiveReply,
  normalizeMessagePresentation,
} from "openclaw/plugin-sdk/interactive-runtime";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { readPositiveIntegerParam, readStringParam } from "openclaw/plugin-sdk/param-readers";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDefaultSlackAccountId } from "./accounts.js";
import { SLACK_MAX_BLOCKS } from "./blocks-input.js";
import { buildSlackPresentationBlocks, canRenderSlackPresentation } from "./blocks-render.js";
import { normalizeSlackOutboundText } from "./format.js";
import { SLACK_EDIT_TEXT_MAX_BYTES } from "./limits.js";
import { parseSlackPermalink, type SlackPermalink } from "./permalink.js";
import { renderSlackMessagePresentationFallbackText } from "./presentation-fallback.js";
import { SLACK_SECTION_TEXT_MAX } from "./presentation.js";
import {
  resolveSlackReplyBlockResolution,
  resolveSlackReplyDeliveryMessages,
  type SlackReplyDeliveryMessage,
} from "./reply-blocks.js";
import { resolveSlackThreadTsValue } from "./thread-ts.js";
import { countSlackTextUtf8Bytes } from "./truncate.js";

type SlackActionInvoke = (
  action: Record<string, unknown>,
  cfg: ChannelMessageActionContext["cfg"],
  toolContext?: ChannelMessageActionContext["toolContext"],
) => Promise<AgentToolResult<unknown>>;

function readSlackForceDocument(params: Record<string, unknown>): boolean {
  return (
    readBooleanParam(params, "forceDocument") ?? readBooleanParam(params, "asDocument") ?? false
  );
}

function resolveSlackPresentationText(
  content: string | undefined,
  presentation: ReturnType<typeof normalizeMessagePresentation>,
): string {
  const hasStructuredData = presentation?.blocks.some(
    (block) => block.type === "chart" || block.type === "table",
  );
  return hasStructuredData
    ? renderSlackMessagePresentationFallbackText({ text: content, presentation })
    : (content ?? "");
}

function renderSlackActionPresentation(
  presentation: ReturnType<typeof normalizeMessagePresentation>,
): {
  blocks?: ReturnType<typeof buildSlackPresentationBlocks>;
  usesPresentationTextFallback: boolean;
} {
  if (!presentation) {
    return { usesPresentationTextFallback: false };
  }
  const needsCompleteTextFallback = presentation.blocks.some(
    (block) =>
      (block.type === "text" || block.type === "context") &&
      block.text.trim().length > SLACK_SECTION_TEXT_MAX,
  );
  const renderedBlocks =
    !needsCompleteTextFallback && canRenderSlackPresentation(presentation)
      ? buildSlackPresentationBlocks(presentation)
      : undefined;
  const usesPresentationTextFallback = !renderedBlocks || renderedBlocks.length > SLACK_MAX_BLOCKS;
  const blocks = usesPresentationTextFallback ? undefined : renderedBlocks;
  return {
    ...(blocks?.length ? { blocks } : {}),
    usesPresentationTextFallback,
  };
}

/** Reads the Slack permalink an action names, from `permalink` or a URL-shaped `url`/`link`. */
export function readSlackPermalinkParam(
  params: Record<string, unknown>,
): SlackPermalink | undefined {
  for (const key of ["permalink", "url", "link"]) {
    const raw = readStringParam(params, key);
    if (!raw) {
      continue;
    }
    const parsed = parseSlackPermalink(raw);
    if (!parsed) {
      throw new Error(
        `${key} is not a Slack message or file permalink (expected https://<workspace>.slack.com/archives/<conversation>/p<ts> or .../files/<user>/<file>/...).`,
      );
    }
    return parsed;
  }
  return undefined;
}

const SLACK_SEARCH_UNAVAILABLE =
  "Slack message search is not available: Slack's search.messages API requires a user token with search:read, and this Slack account only has a bot token. " +
  'Use action="read" with a channelId (and threadId) or a Slack permalink, or action="download-file" with a file permalink.';

/** Translate generic channel action requests into Slack-specific tool invocations and payload shapes. */
export async function handleSlackMessageAction(params: {
  providerId: string;
  ctx: ChannelMessageActionContext;
  invoke: SlackActionInvoke;
  normalizeChannelId?: (channelId: string) => string;
  includeReadThreadId?: boolean;
}): Promise<AgentToolResult<unknown>> {
  const { providerId, ctx, invoke, normalizeChannelId, includeReadThreadId = false } = params;
  const { action, cfg, params: actionParams } = ctx;
  const accountId = ctx.accountId ?? undefined;
  const resolveChannelId = () => {
    const channelId =
      readStringParam(actionParams, "channelId") ??
      readStringParam(actionParams, "to", { required: true });
    return normalizeChannelId ? normalizeChannelId(channelId) : channelId;
  };

  if (action === "conversation-open") {
    return await invoke(
      {
        action: "openConversation",
        userIds: actionParams.userIds,
        teamId: readStringParam(actionParams, "teamId"),
        accountId,
      },
      cfg,
      ctx.toolContext,
    );
  }

  if (action === "search") {
    throw new Error(SLACK_SEARCH_UNAVAILABLE);
  }

  if (action === "send" || action === "thread-reply") {
    const to = readStringParam(actionParams, "to", { required: true });
    const content = readStringParam(actionParams, "message", {
      required: false,
      allowEmpty: true,
    });
    const mediaUrl = readStringParam(actionParams, "media", { trim: false });
    const presentation = normalizeMessagePresentation(actionParams.presentation);
    const interactive = normalizeLegacyInteractiveReply(actionParams.interactive);
    const hasStructuredContent = Boolean(presentation || interactive?.blocks.length);
    const resolution = resolveSlackReplyBlockResolution(
      {
        text: content,
        presentation,
        interactive,
      },
      { materializeAuthoredText: hasStructuredContent },
    );
    const preparedMessages =
      resolution.segments.length > 0
        ? resolveSlackReplyDeliveryMessages({
            authoredTextPlacement: resolution.authoredTextPlacement,
            segments: resolution.segments,
            text: content,
          })
        : [];
    if (!content && preparedMessages.length === 0 && !mediaUrl) {
      throw new Error("Slack send requires message, blocks, or media.");
    }
    const replyBroadcast = readBooleanParam(actionParams, "replyBroadcast");
    if (replyBroadcast && mediaUrl) {
      throw new Error("Slack replyBroadcast is only supported for text or block thread replies.");
    }
    const threadId = readStringParam(actionParams, "threadId");
    const replyTo = readStringParam(actionParams, "replyTo");
    const topLevel =
      readBooleanParam(actionParams, "topLevel") === true || actionParams.threadId === null;
    // thread-reply is a send that must land in a thread: the named parent
    // (threadId/replyTo/messageId) or, failing that, the current Slack thread.
    const threadReplyTs =
      action === "thread-reply"
        ? (resolveSlackThreadTsValue({
            replyToId: replyTo ?? readStringParam(actionParams, "messageId"),
            threadId,
          }) ?? normalizeOptionalString(ctx.toolContext?.currentThreadTs))
        : undefined;
    if (action === "thread-reply" && (!threadReplyTs || topLevel)) {
      throw new Error(
        "Slack thread-reply requires threadId (the parent message timestamp) or replyTo, or must be called from inside a Slack thread.",
      );
    }
    const toolContext =
      preparedMessages.length > 0
        ? {
            ...ctx.toolContext,
            preparedMessages: preparedMessages satisfies readonly SlackReplyDeliveryMessage[],
          }
        : ctx.toolContext;
    return await invoke(
      {
        action: "sendMessage",
        to,
        content: content ?? "",
        mediaUrl: mediaUrl ?? undefined,
        ...(readSlackForceDocument(actionParams) ? { forceDocument: true } : {}),
        accountId,
        threadTs: threadReplyTs ?? resolveSlackThreadTsValue({ replyToId: replyTo, threadId }),
        ...(topLevel ? { topLevel: true } : {}),
        ...(replyBroadcast ? { replyBroadcast } : {}),
      },
      cfg,
      toolContext,
    );
  }

  if (action === "react") {
    const messageIdRaw = resolveReactionMessageId({
      args: actionParams,
      toolContext: ctx.toolContext,
    });
    if (messageIdRaw == null) {
      throw new Error(
        "messageId required. Provide messageId explicitly or react to the current inbound message.",
      );
    }
    const messageId = String(messageIdRaw);
    const emoji = readStringParam(actionParams, "emoji", { allowEmpty: true });
    const remove = typeof actionParams.remove === "boolean" ? actionParams.remove : undefined;
    return await invoke(
      {
        action: "react",
        channelId: resolveChannelId(),
        messageId,
        emoji,
        remove,
        accountId,
      },
      cfg,
      ctx.toolContext,
    );
  }

  if (action === "reactions") {
    const messageId = readStringParam(actionParams, "messageId", {
      required: true,
    });
    return await invoke(
      {
        action: "reactions",
        channelId: resolveChannelId(),
        messageId,
        limit: actionParams.limit,
        accountId,
      },
      cfg,
      ctx.toolContext,
    );
  }

  if (action === "read") {
    const permalink = readSlackPermalinkParam(actionParams);
    if (permalink?.kind === "file") {
      throw new Error(
        'That permalink names a Slack file; use action="download-file" with the same permalink.',
      );
    }
    const readAction: Record<string, unknown> = {
      action: "readMessages",
      channelId: permalink
        ? normalizeChannelId
          ? normalizeChannelId(permalink.channelId)
          : permalink.channelId
        : resolveChannelId(),
      limit: actionParams.limit,
      before: readStringParam(actionParams, "before"),
      after: readStringParam(actionParams, "after"),
      messageId: readStringParam(actionParams, "messageId") ?? permalink?.messageTs,
      accountId,
    };
    if (includeReadThreadId) {
      readAction.threadId = readStringParam(actionParams, "threadId") ?? permalink?.threadTs;
    }
    return await invoke(readAction, cfg, ctx.toolContext);
  }

  if (action === "edit") {
    const messageId = readStringParam(actionParams, "messageId", {
      required: true,
    });
    const content = readStringParam(actionParams, "message", { allowEmpty: true });
    const presentation = normalizeMessagePresentation(actionParams.presentation);
    const renderedPresentation = renderSlackActionPresentation(presentation);
    // Slack hides top-level text when blocks are present on updates. Keep an
    // unrenderable presentation text-only so its complete fallback stays visible.
    const blocks = renderedPresentation.usesPresentationTextFallback
      ? undefined
      : renderedPresentation.blocks;
    const accessibleContent = renderedPresentation.usesPresentationTextFallback
      ? renderSlackMessagePresentationFallbackText({ text: content, presentation })
      : resolveSlackPresentationText(content, presentation);
    const tableMode = resolveMarkdownTableMode({
      cfg,
      channel: "slack",
      accountId: accountId ?? resolveDefaultSlackAccountId(cfg),
    });
    if (
      !blocks &&
      countSlackTextUtf8Bytes(normalizeSlackOutboundText(accessibleContent, { tableMode })) >
        SLACK_EDIT_TEXT_MAX_BYTES
    ) {
      const editSubject = renderedPresentation.usesPresentationTextFallback
        ? "Slack presentation fallback"
        : "Slack edit";
      throw new Error(
        `${editSubject} exceeds the ${String(SLACK_EDIT_TEXT_MAX_BYTES)}-byte edit limit. Send a new message instead.`,
      );
    }
    if (!accessibleContent && !blocks) {
      throw new Error("Slack edit requires message or blocks.");
    }
    return await invoke(
      {
        action: "editMessage",
        channelId: resolveChannelId(),
        messageId,
        content: accessibleContent,
        blocks,
        accountId,
      },
      cfg,
      ctx.toolContext,
    );
  }

  if (action === "delete") {
    const messageId = readStringParam(actionParams, "messageId", {
      required: true,
    });
    return await invoke(
      {
        action: "deleteMessage",
        channelId: resolveChannelId(),
        messageId,
        accountId,
      },
      cfg,
      ctx.toolContext,
    );
  }

  if (action === "pin" || action === "unpin" || action === "list-pins") {
    const messageId =
      action === "list-pins"
        ? undefined
        : readStringParam(actionParams, "messageId", { required: true });
    return await invoke(
      {
        action: action === "pin" ? "pinMessage" : action === "unpin" ? "unpinMessage" : "listPins",
        channelId: resolveChannelId(),
        messageId,
        accountId,
      },
      cfg,
      ctx.toolContext,
    );
  }

  if (action === "member-info") {
    const requesterAccountId = ctx.requesterAccountId
      ? normalizeAccountId(ctx.requesterAccountId)
      : undefined;
    const targetAccountId = normalizeAccountId(accountId ?? resolveDefaultSlackAccountId(cfg));
    const requesterUserId =
      normalizeOptionalLowercaseString(ctx.toolContext?.currentChannelProvider) === "slack" &&
      requesterAccountId !== undefined &&
      requesterAccountId === targetAccountId
        ? normalizeOptionalString(ctx.requesterSenderId)
        : undefined;
    const userId = readStringParam(actionParams, "userId") ?? requesterUserId;
    if (!userId) {
      throw new Error("member-info requires a userId outside a current Slack conversation.");
    }
    return await invoke({ action: "memberInfo", userId, accountId }, cfg, ctx.toolContext);
  }

  if (action === "emoji-list") {
    const limit = readPositiveIntegerParam(actionParams, "limit", {
      message: "limit must be a positive integer.",
    });
    return await invoke({ action: "emojiList", limit, accountId }, cfg, ctx.toolContext);
  }

  if (action === "download-file") {
    const permalink = readSlackPermalinkParam(actionParams);
    const explicitFileId = readStringParam(actionParams, "fileId");
    if (
      permalink?.kind === "file" &&
      explicitFileId &&
      explicitFileId.toUpperCase() !== permalink.fileId
    ) {
      throw new Error("download-file received a fileId that differs from the file permalink.");
    }
    const fileIdParam = permalink?.kind === "file" ? permalink.fileId : explicitFileId;
    const allThreadFiles = readBooleanParam(actionParams, "allThreadFiles") === true;
    const fileIdsParam = actionParams.fileIds;
    const fileIds = Array.isArray(fileIdsParam)
      ? fileIdsParam.map((value) => (typeof value === "string" ? value.trim() : ""))
      : undefined;
    if (fileIdsParam !== undefined && (!fileIds || fileIds.some((value) => !value))) {
      throw new Error("download-file fileIds must be an array of non-empty Slack file ids.");
    }
    const uniqueFileIds = fileIds ? Array.from(new Set(fileIds)) : undefined;
    if (uniqueFileIds && (uniqueFileIds.length === 0 || uniqueFileIds.length > 20)) {
      throw new Error("download-file fileIds must contain between 1 and 20 unique ids.");
    }
    if ([Boolean(fileIdParam), Boolean(uniqueFileIds), allThreadFiles].filter(Boolean).length > 1) {
      throw new Error("download-file accepts exactly one of fileId, fileIds, or allThreadFiles.");
    }
    const messageIdParam =
      readStringParam(actionParams, "messageId") ?? readStringParam(actionParams, "message_id");
    const permalinkMessageTs =
      permalink?.kind === "message" && !fileIdParam && !uniqueFileIds && !allThreadFiles
        ? permalink.messageTs
        : undefined;
    if (permalink?.kind === "message" && !fileIdParam && !uniqueFileIds && !allThreadFiles) {
      if (!permalinkMessageTs) {
        throw new Error(
          "download-file needs a message or file permalink; a conversation link names no file.",
        );
      }
    } else if (!fileIdParam && !uniqueFileIds && messageIdParam) {
      throw new Error(
        "download-file requires fileId (the Slack file id, for example F0B0LTT8M36 from event.files[].id), not messageId. Did you mean to pass fileId? messageId is the Slack message timestamp and is used by react / reactions / edit / delete / pin / unpin actions, not download-file.",
      );
    }
    if (!fileIdParam && !uniqueFileIds && !allThreadFiles && !permalinkMessageTs) {
      throw new Error("download-file requires fileId, fileIds, or allThreadFiles.");
    }
    const explicitChannelId =
      readStringParam(actionParams, "channelId") ?? readStringParam(actionParams, "to");
    const channelId =
      permalink?.kind === "message"
        ? normalizeChannelId
          ? normalizeChannelId(permalink.channelId)
          : permalink.channelId
        : explicitChannelId;
    const threadId =
      readStringParam(actionParams, "threadId") ??
      readStringParam(actionParams, "replyTo") ??
      (permalink?.kind === "message" ? permalink.threadTs : undefined);
    if (allThreadFiles && !threadId) {
      throw new Error("download-file allThreadFiles requires threadId.");
    }
    return await invoke(
      {
        action: "downloadFile",
        fileId: fileIdParam,
        fileIds: uniqueFileIds,
        allThreadFiles,
        ...(permalinkMessageTs ? { messageId: permalinkMessageTs } : {}),
        ...(permalink?.kind === "file" && !explicitChannelId ? { fromPermalink: true } : {}),
        ...(readBooleanParam(actionParams, "original") === true ? { original: true } : {}),
        channelId: channelId ?? undefined,
        threadId: threadId ?? undefined,
        accountId,
      },
      cfg,
      ctx.toolContext,
    );
  }

  if (action === "upload-file") {
    const replyBroadcast = readBooleanParam(actionParams, "replyBroadcast");
    if (replyBroadcast) {
      throw new Error("Slack replyBroadcast is only supported for text or block thread replies.");
    }
    const to = readStringParam(actionParams, "to") ?? resolveChannelId();
    const filePath =
      readStringParam(actionParams, "filePath", { trim: false }) ??
      readStringParam(actionParams, "path", { trim: false }) ??
      readStringParam(actionParams, "media", { trim: false });
    if (!filePath) {
      throw new Error("upload-file requires filePath, path, or media");
    }
    const threadId =
      readStringParam(actionParams, "threadId") ?? readStringParam(actionParams, "replyTo");
    const topLevel =
      readBooleanParam(actionParams, "topLevel") === true || actionParams.threadId === null;
    return await invoke(
      {
        action: "uploadFile",
        to,
        filePath,
        initialComment:
          readStringParam(actionParams, "initialComment", { allowEmpty: true }) ??
          readStringParam(actionParams, "message", { allowEmpty: true }) ??
          // `media` is accepted as an alias for the file, so a send-shaped call
          // arrives with its text in `caption`; without this alias that text is
          // silently dropped instead of becoming the upload's first comment.
          readStringParam(actionParams, "caption", { allowEmpty: true }) ??
          "",
        filename: readStringParam(actionParams, "filename"),
        title: readStringParam(actionParams, "title"),
        threadTs: threadId ?? undefined,
        ...(readSlackForceDocument(actionParams) ? { forceDocument: true } : {}),
        ...(topLevel ? { topLevel: true } : {}),
        accountId,
      },
      cfg,
      ctx.toolContext,
    );
  }

  throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
}
