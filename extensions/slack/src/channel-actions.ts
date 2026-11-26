import { normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { readBooleanParam } from "openclaw/plugin-sdk/boolean-param";
import { resolveReactionMessageId } from "openclaw/plugin-sdk/channel-actions";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
} from "openclaw/plugin-sdk/channel-contract";
import {
  normalizeLegacyInteractiveReply,
  normalizeMessagePresentation,
} from "openclaw/plugin-sdk/interactive-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { readPositiveIntegerParam, readStringParam } from "openclaw/plugin-sdk/param-readers";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDefaultSlackAccountId, resolveSlackMarkdownOptions } from "./accounts.js";
import type { SlackActionContext } from "./action-context.js";
import type { SlackBlock } from "./blocks-render.js";
import { normalizeSlackOutboundText } from "./format.js";
import { SLACK_EDIT_TEXT_MAX_BYTES } from "./limits.js";
import { extractSlackToolSend } from "./message-actions.js";
import { describeSlackMessageTool } from "./message-tool-api.js";
import { parseSlackPermalink, type SlackPermalink } from "./permalink.js";
import { renderSlackMessagePresentationFallbackText } from "./presentation-fallback.js";
import { SLACK_SECTION_TEXT_MAX } from "./presentation.js";
import {
  resolveSlackReplyBlockResolution,
  resolveSlackReplyDeliveryMessages,
  type SlackReplyDeliveryMessage,
} from "./reply-blocks.js";
import { formatSlackTarget, parseSlackTarget, resolveSlackChannelId } from "./target-parsing.js";
import { resolveSlackThreadTsValue } from "./thread-ts.js";
import { countSlackTextUtf8Bytes } from "./truncate.js";

type SlackActionInvoke = (
  action: Record<string, unknown>,
  cfg: unknown,
  toolContext: unknown,
) => Promise<AgentToolResult<unknown>>;

const SLACK_MESSAGE_ACTIONS = new Map([
  ["reactions", "reactions"],
  ["delete", "deleteMessage"],
  ["pin", "pinMessage"],
  ["unpin", "unpinMessage"],
  ["list-pins", "listPins"],
]);

/** Reads the Slack permalink an action names, from `permalink` or a URL-shaped `url`/`link`. */
function readSlackPermalinkParam(params: Record<string, unknown>): SlackPermalink | undefined {
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

function readSlackForceDocument(params: Record<string, unknown>): boolean {
  return (
    readBooleanParam(params, "forceDocument") ?? readBooleanParam(params, "asDocument") ?? false
  );
}

function renderSlackActionPresentation(
  content: string | undefined,
  presentation: ReturnType<typeof normalizeMessagePresentation>,
  markdownOptions: ReturnType<typeof resolveSlackMarkdownOptions>,
): {
  blocks?: SlackBlock[];
  text: string;
  usesPresentationTextFallback: boolean;
} {
  // Portable presentation text already uses Slack mrkdwn; render only authored Markdown.
  const renderedContent = normalizeSlackOutboundText(content ?? "", markdownOptions);
  if (!presentation) {
    return { text: renderedContent, usesPresentationTextFallback: false };
  }
  const resolution = resolveSlackReplyBlockResolution(
    { text: content, presentation },
    markdownOptions,
  );
  const segment = resolution.segments.length === 1 ? resolution.segments[0] : undefined;
  // Edits retain their single-message fallback even though normal sends can chunk.
  const usesPresentationTextFallback =
    segment?.kind !== "blocks" ||
    presentation.blocks.some(
      (block) =>
        (block.type === "text" || block.type === "context") &&
        block.text.trim().length > SLACK_SECTION_TEXT_MAX,
    );
  const blocks =
    !usesPresentationTextFallback && segment?.kind === "blocks" ? segment.blocks : undefined;
  return {
    ...(blocks?.length ? { blocks } : {}),
    text:
      usesPresentationTextFallback ||
      presentation.blocks.some((block) => block.type === "chart" || block.type === "table")
        ? renderSlackMessagePresentationFallbackText({
            text: resolution.authoredTextPlacement === "blocks" ? undefined : renderedContent,
            presentation,
          })
        : renderedContent,
    usesPresentationTextFallback,
  };
}

const SLACK_TOOL_DELIVERY_ACTIONS = new Set([
  "deleteMessage",
  "editMessage",
  "pinMessage",
  "react",
  "sendMessage",
  "unpinMessage",
  "uploadFile",
]);

const loadSlackActionRuntime = createLazyRuntimeModule(() => import("./action-runtime.runtime.js"));

const SLACK_PERMALINK_PARAM_KEYS = ["permalink", "url", "link"];

/** A pasted message permalink names the conversation to read; Slack gates the read itself. */
function resolveSlackPermalinkReadTarget(args: Record<string, unknown>): string | undefined {
  for (const key of SLACK_PERMALINK_PARAM_KEYS) {
    const parsed = parseSlackPermalink(args[key]);
    if (parsed?.kind === "message") {
      return parsed.channelId;
    }
  }
  return undefined;
}

function resolveSlackActionContext(
  ctx: ChannelMessageActionContext,
  toolContext: unknown,
): SlackActionContext | undefined {
  if (
    !toolContext &&
    !ctx.mediaAccess &&
    !ctx.mediaLocalRoots &&
    !ctx.mediaReadFile &&
    !ctx.conversationReadOrigin &&
    !ctx.requesterAccountId &&
    !ctx.requesterSenderId &&
    !ctx.assertDirectAdapterHandoff
  ) {
    return undefined;
  }
  return {
    ...(toolContext as SlackActionContext | undefined),
    // Authority comes only from the host-owned action context. Overwrite any
    // structurally compatible fields carried by generic tool context.
    mediaAccess: ctx.mediaAccess,
    mediaLocalRoots: ctx.mediaLocalRoots,
    mediaReadFile: ctx.mediaReadFile,
    conversationReadOrigin: ctx.conversationReadOrigin,
    agentId: ctx.agentId ?? undefined,
    sessionKey: ctx.sessionKey ?? undefined,
    requesterAccountId: ctx.requesterAccountId ?? undefined,
    requesterSenderId: ctx.requesterSenderId ?? undefined,
    assertDirectAdapterHandoff: ctx.assertDirectAdapterHandoff,
    mediaWorkspaceDir: ctx.mediaAccess?.workspaceDir,
  };
}

export function createSlackActions(
  providerId: string,
  options?: { invoke?: SlackActionInvoke },
): ChannelMessageActionAdapter {
  return {
    providerOwnedReadGates: true,
    readAuthorityActions: [
      "read",
      "reactions",
      "list-pins",
      "member-info",
      "emoji-list",
      "download-file",
    ],
    messageActionTargetAliases: {
      read: {
        aliases: SLACK_PERMALINK_PARAM_KEYS,
        resolveDeliveryTarget: ({ args }) => resolveSlackPermalinkReadTarget(args),
      },
    },
    describeMessageTool: describeSlackMessageTool,
    extractToolSend: ({ args }) => extractSlackToolSend(args),
    isToolDeliveryAction: ({ args }) =>
      typeof args.action === "string" && SLACK_TOOL_DELIVERY_ACTIONS.has(args.action),
    prepareSendPayload: ({ ctx, to, payload }) => {
      if (ctx.action !== "send") {
        return null;
      }
      // `replyBroadcast` has no durable payload field, so the core send path would drop it.
      // Keep those sends on the plugin action path, which forwards `reply_broadcast`.
      if (readBooleanParam(ctx.params, "replyBroadcast") === true) {
        return null;
      }
      return shouldUseWorkspaceAwareSlackActionSend(to, ctx.toolContext) ? null : payload;
    },
    handleAction: async (ctx) => {
      const { action, cfg, params: actionParams } = ctx;
      const accountId = ctx.accountId ?? undefined;
      const invokeSlackAction = async (
        request: Record<string, unknown>,
        toolContext: SlackActionContext | undefined = ctx.toolContext,
      ) => {
        const requestAction = { ...request, accountId };
        const actionContext = resolveSlackActionContext(ctx, toolContext);
        return await (options?.invoke
          ? options.invoke(requestAction, cfg, actionContext)
          : (await loadSlackActionRuntime()).handleSlackAction(requestAction, cfg, actionContext));
      };
      const resolveChannelId = () => {
        const raw =
          readStringParam(actionParams, "channelId") ??
          readStringParam(actionParams, "to", { required: true });
        const target = parseSlackTarget(raw, { defaultKind: "channel" });
        const channelId = resolveSlackChannelId(raw);
        return formatSlackTarget({ teamId: target?.teamId, kind: "channel", id: channelId });
      };

      if (action === "channel-create") {
        return await invokeSlackAction({
          action: "createChannel",
          name: readStringParam(actionParams, "name", { required: true }),
          teamId: readStringParam(actionParams, "teamId"),
        });
      }

      if (action === "conversation-open") {
        return await invokeSlackAction({
          action: "openConversation",
          userIds: actionParams.userIds,
          teamId: readStringParam(actionParams, "teamId"),
        });
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
          {
            ...resolveSlackMarkdownOptions({ cfg, accountId }),
            materializeAuthoredText: hasStructuredContent,
          },
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
          throw new Error(
            "Slack replyBroadcast is only supported for text or block thread replies.",
          );
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
        return await invokeSlackAction(
          {
            action: "sendMessage",
            to,
            content: content ?? "",
            mediaUrl,
            ...(readSlackForceDocument(actionParams) ? { forceDocument: true } : {}),
            threadTs: threadReplyTs ?? resolveSlackThreadTsValue({ replyToId: replyTo, threadId }),
            ...(topLevel ? { topLevel: true } : {}),
            ...(replyBroadcast ? { replyBroadcast } : {}),
          },
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
        return await invokeSlackAction({
          action: "react",
          channelId: resolveChannelId(),
          messageId,
          emoji,
          remove,
        });
      }

      const messageAction = SLACK_MESSAGE_ACTIONS.get(action);
      if (messageAction) {
        const messageId =
          action === "list-pins"
            ? undefined
            : readStringParam(actionParams, "messageId", { required: true });
        return await invokeSlackAction({
          action: messageAction,
          channelId: resolveChannelId(),
          messageId,
          ...(action === "reactions" || action === "list-pins"
            ? { limit: actionParams.limit }
            : {}),
        });
      }

      if (action === "read") {
        const permalink = readSlackPermalinkParam(actionParams);
        if (permalink?.kind === "file") {
          throw new Error(
            'That permalink names a Slack file; use action="download-file" with the same permalink.',
          );
        }
        return await invokeSlackAction({
          action: "readMessages",
          channelId: permalink
            ? formatSlackTarget({ kind: "channel", id: resolveSlackChannelId(permalink.channelId) })
            : resolveChannelId(),
          limit: actionParams.limit,
          before: readStringParam(actionParams, "before"),
          after: readStringParam(actionParams, "after"),
          messageId: readStringParam(actionParams, "messageId") ?? permalink?.messageTs,
          threadId: readStringParam(actionParams, "threadId") ?? permalink?.threadTs,
        });
      }

      if (action === "edit") {
        const messageId = readStringParam(actionParams, "messageId", {
          required: true,
        });
        const content = readStringParam(actionParams, "message", { allowEmpty: true });
        const presentation = normalizeMessagePresentation(actionParams.presentation);
        // Slack hides top-level text when blocks are present on updates. Keep an
        // unrenderable presentation text-only so its complete fallback stays visible.
        const {
          blocks,
          text: accessibleContent,
          usesPresentationTextFallback,
        } = renderSlackActionPresentation(
          content,
          presentation,
          resolveSlackMarkdownOptions({ cfg, accountId }),
        );
        if (!blocks && countSlackTextUtf8Bytes(accessibleContent) > SLACK_EDIT_TEXT_MAX_BYTES) {
          const editSubject = usesPresentationTextFallback
            ? "Slack presentation fallback"
            : "Slack edit";
          throw new Error(
            `${editSubject} exceeds the ${String(SLACK_EDIT_TEXT_MAX_BYTES)}-byte edit limit. Send a new message instead.`,
          );
        }
        if (!accessibleContent && !blocks) {
          throw new Error("Slack edit requires message or blocks.");
        }
        return await invokeSlackAction(
          {
            action: "editMessage",
            channelId: resolveChannelId(),
            messageId,
            content: accessibleContent,
            blocks,
          },
          { ...ctx.toolContext, preparedEditText: accessibleContent },
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
        return await invokeSlackAction({ action: "memberInfo", userId });
      }

      if (action === "emoji-list") {
        const limit = readPositiveIntegerParam(actionParams, "limit", {
          message: "limit must be a positive integer.",
        });
        return await invokeSlackAction({ action: "emojiList", limit });
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
        if (
          [Boolean(fileIdParam), Boolean(uniqueFileIds), allThreadFiles].filter(Boolean).length > 1
        ) {
          throw new Error(
            "download-file accepts exactly one of fileId, fileIds, or allThreadFiles.",
          );
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
            ? formatSlackTarget({ kind: "channel", id: resolveSlackChannelId(permalink.channelId) })
            : explicitChannelId;
        const threadId =
          readStringParam(actionParams, "threadId") ??
          readStringParam(actionParams, "replyTo") ??
          (permalink?.kind === "message" ? permalink.threadTs : undefined);
        if (allThreadFiles && !threadId) {
          throw new Error("download-file allThreadFiles requires threadId.");
        }
        return await invokeSlackAction({
          action: "downloadFile",
          fileId: fileIdParam,
          fileIds: uniqueFileIds,
          allThreadFiles,
          ...(permalinkMessageTs ? { messageId: permalinkMessageTs } : {}),
          ...(permalink?.kind === "file" && !explicitChannelId ? { fromPermalink: true } : {}),
          ...(readBooleanParam(actionParams, "original") === true ? { original: true } : {}),
          channelId: channelId ?? undefined,
          threadId: threadId ?? undefined,
        });
      }

      if (action === "upload-file") {
        const replyBroadcast = readBooleanParam(actionParams, "replyBroadcast");
        if (replyBroadcast) {
          throw new Error(
            "Slack replyBroadcast is only supported for text or block thread replies.",
          );
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
        return await invokeSlackAction({
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
          threadTs: threadId,
          ...(readSlackForceDocument(actionParams) ? { forceDocument: true } : {}),
          ...(topLevel ? { topLevel: true } : {}),
        });
      }

      throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
    },
  };
}

function shouldUseWorkspaceAwareSlackActionSend(
  rawTarget: string,
  context: ChannelMessageActionContext["toolContext"],
): boolean {
  const target = parseSlackTarget(rawTarget, { defaultKind: "channel" });
  if (!target || target.teamId) {
    return false;
  }
  for (const rawCurrentTarget of [context?.currentChannelId, context?.currentMessagingTarget]) {
    if (!rawCurrentTarget) {
      continue;
    }
    const currentTarget = parseSlackTarget(rawCurrentTarget);
    if (
      currentTarget?.teamId &&
      currentTarget.kind === target.kind &&
      currentTarget.id.toLowerCase() === target.id.toLowerCase()
    ) {
      return true;
    }
  }
  return false;
}
