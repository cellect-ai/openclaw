import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ResolvedSlackAccount } from "./accounts.js";
import type { SlackActionContext } from "./action-context.js";
import { stageDownloadedSlackFile, hashSlackFile } from "./action-files.js";
import {
  hasSlackRequesterAccount,
  assertSlackMemberInfoAllowed,
  assertSlackReadTargetAllowed,
} from "./action-read-policy.js";
import { slackActionRuntime } from "./action-runtime-bindings.js";
import type { SlackSendResult } from "./send.js";
export { slackActionRuntime } from "./action-runtime-bindings.js";

import { stat } from "node:fs/promises";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
import { readBooleanParam } from "openclaw/plugin-sdk/boolean-param";
import {
  createActionGate,
  imageResultFromFile,
  jsonResult,
  readPositiveIntegerParam,
  readReactionParams,
  readStringParam,
  withNormalizedTimestamp,
} from "openclaw/plugin-sdk/channel-actions";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  resolveSlackThreadTsFromContext,
  SLACK_PRIVATE_ACTION_DELIVERY_RESULT,
} from "./action-threading.js";
import { assertSlackDetachedTargetAllowed } from "./detached-target-admission.js";
import { resolveSlackMediaMaxBytes, SLACK_TEXT_LIMIT } from "./limits.js";
import { hasSlackNativeDataBlock } from "./native-data-blocks.js";
import { prepareMatrixSlackRead } from "./read-requester.js";
import { mergeSlackSendResults } from "./send-results.js";
import { formatSlackTarget } from "./target-parsing.js";
import { parseSlackTarget, resolveSlackChannelId, slackContextTargetsMatch } from "./targets.js";

const messagingActions = new Set([
  "openConversation",
  "sendMessage",
  "uploadFile",
  "editMessage",
  "deleteMessage",
  "readMessages",
  "downloadFile",
]);

const reactionsActions = new Set(["react", "reactions"]);
const pinActions = new Set(["pinMessage", "unpinMessage", "listPins"]);
const SLACK_REACTION_RESULT_LIMIT = 100;

function readSlackResultLimit(params: Record<string, unknown>) {
  return Math.min(
    readPositiveIntegerParam(params, "limit", {
      message: "limit must be a positive integer.",
    }) ?? SLACK_REACTION_RESULT_LIMIT,
    SLACK_REACTION_RESULT_LIMIT,
  );
}

const loadSlackAccountsRuntime = createLazyRuntimeModule(() => import("./accounts.js"));

export type { SlackActionContext } from "./action-context.js";

/**
 * The trusted requester must be in the conversation: a member of the channel,
 * or the peer of the DM. Fails closed when no Slack identity is linked.
 */

/**
 * A Fi (Matrix) turn acts for one person: whatever the account's channel
 * policy admits, the conversation must also be one that person can read in
 * Slack. Direct operator reads keep their own authority.
 */

type SlackActionChannelTarget = {
  channelId: string;
  teamId?: string;
};

function resolveTrustedCurrentSlackTeamId(params: {
  account: ResolvedSlackAccount;
  target?: NonNullable<ReturnType<typeof parseSlackTarget>>;
  context?: SlackActionContext;
}): string | undefined {
  if (!hasSlackRequesterAccount(params.account, params.context)) {
    return undefined;
  }

  const matchingTeams = new Map<string, string>();
  for (const raw of [params.context?.currentChannelId, params.context?.currentMessagingTarget]) {
    if (!raw) {
      continue;
    }
    const current = parseSlackTarget(raw);
    if (
      current?.teamId &&
      (!params.target ||
        (current.kind === params.target.kind &&
          current.id.toLowerCase() === params.target.id.toLowerCase()))
    ) {
      matchingTeams.set(current.teamId.toLowerCase(), current.teamId);
    }
  }
  return matchingTeams.size === 1 ? matchingTeams.values().next().value : undefined;
}

function resolveSlackActionTarget(
  account: ResolvedSlackAccount,
  raw: string,
  context?: SlackActionContext,
) {
  const parsed = parseSlackTarget(raw, { defaultKind: "channel" });
  if (!parsed) {
    throw new Error("Slack target is required.");
  }
  const teamId =
    parsed.teamId ?? resolveTrustedCurrentSlackTeamId({ account, target: parsed, context });
  assertSlackDetachedTargetAllowed(account.accountId, teamId);
  return {
    routingTarget: teamId ? formatSlackTarget({ teamId, kind: parsed.kind, id: parsed.id }) : raw,
    teamId,
  };
}

function resolveSlackActionChannelTarget(
  account: ResolvedSlackAccount,
  raw: string,
  context?: SlackActionContext,
): SlackActionChannelTarget {
  const resolved = resolveSlackActionTarget(account, raw, context);
  const channelId = resolveSlackChannelId(raw);
  return {
    channelId,
    teamId: resolved.teamId,
  };
}

/**
 * The one Slack account explicitly bound to the acting agent, for a read a
 * Matrix (Fi chat) turn makes without naming an account. Wildcard bindings and
 * several candidates select nothing, so the default account's checks apply.
 */
export function resolveMatrixReadAccountId(
  cfg: OpenClawConfig,
  context: SlackActionContext | undefined,
): string | undefined {
  const agentId = context?.agentId?.trim().toLowerCase();
  if (
    !agentId ||
    context?.currentChannelProvider?.trim().toLowerCase() !== "matrix" ||
    context.conversationReadOrigin === "direct-operator"
  ) {
    return undefined;
  }
  const candidates = new Set(
    (cfg.bindings ?? [])
      .filter(
        (binding) =>
          ((binding as { type?: string }).type ?? "route") === "route" &&
          binding.agentId?.trim().toLowerCase() === agentId &&
          binding.match?.channel?.trim().toLowerCase() === "slack",
      )
      .map((binding) => binding.match.accountId?.trim())
      .filter((id): id is string => Boolean(id) && id !== "*")
      .map((id) => normalizeAccountId(id)),
  );
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

export async function handleSlackAction(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
  context?: SlackActionContext,
): Promise<AgentToolResult<unknown>> {
  const action = readStringParam(params, "action", { required: true });
  // A Fi (Matrix) turn reading a pasted Slack link names no Slack account. Use
  // this agent's own explicitly bound Slack account; the read below still
  // proves that account's workspace, its route to this agent, and the
  // requester's own membership through their linked Slack identity.
  const accountId =
    readStringParam(params, "accountId") ??
    (action === "readMessages" ? resolveMatrixReadAccountId(cfg, context) : undefined);
  const { resolveSlackAccount, resolveSlackOperationToken } = await loadSlackAccountsRuntime();
  const account = resolveSlackAccount({ cfg, accountId });
  const resolveChannelTarget = () =>
    resolveSlackActionChannelTarget(
      account,
      readStringParam(params, "channelId", {
        required: true,
      }),
      context,
    );
  const actionConfig = account.actions ?? cfg.channels?.slack?.actions;
  const isActionEnabled = createActionGate(actionConfig);
  const botToken = account.botToken?.trim();

  if (action === "createChannel" && !isActionEnabled("channels", false)) {
    throw new Error("Slack channel creation is disabled.");
  }

  const buildActionOpts = (operation: "read" | "write", teamId?: string) => {
    const token = resolveSlackOperationToken(account, operation);
    if (!token && account.identity === "user") {
      throw new Error(`Slack operation token missing for account "${account.accountId}".`);
    }
    const tokenOverride = token && token !== botToken ? token : undefined;
    return {
      cfg,
      ...(accountId ? { accountId } : {}),
      ...(tokenOverride ? { token: tokenOverride } : {}),
      teamId,
      assertDirectAdapterHandoff: context?.assertDirectAdapterHandoff,
    };
  };

  // Every Slack action a Fi (Matrix) turn takes is bounded by what its requester
  // can read in Slack; this only narrows, it never admits a target.
  const personScoped =
    normalizeOptionalLowercaseString(context?.currentChannelProvider) === "matrix" &&
    context?.conversationReadOrigin !== "direct-operator";
  const assertReadTargetAllowed = async (
    target: SlackActionChannelTarget,
    opts?: { allowRequesterMembership?: boolean; preparedWorkspaceId?: string },
  ) => {
    await assertSlackReadTargetAllowed({
      ...(personScoped
        ? {
            personScope: {
              readOpts: buildActionOpts("read", target.teamId),
              preparedWorkspaceId: opts?.preparedWorkspaceId,
            },
          }
        : {}),
      account,
      cfg,
      channelId: target.channelId,
      teamId: target.teamId,
      conversationReadOrigin: context?.conversationReadOrigin,
      context,
      ...(opts?.allowRequesterMembership
        ? {
            requesterMembership: {
              readOpts: buildActionOpts("read", target.teamId),
              preparedWorkspaceId: opts.preparedWorkspaceId,
            },
          }
        : {}),
    });
  };

  if (action === "createChannel") {
    const teamId =
      readStringParam(params, "teamId") ?? resolveTrustedCurrentSlackTeamId({ account, context });
    const inviteUserId =
      normalizeOptionalLowercaseString(context?.currentChannelProvider) === "slack" &&
      context?.requesterAccountId &&
      normalizeAccountId(context.requesterAccountId) === normalizeAccountId(account.accountId)
        ? context?.requesterSenderId
        : undefined;
    assertSlackDetachedTargetAllowed(account.accountId, teamId);
    const result = await slackActionRuntime.createSlackChannel(
      readStringParam(params, "name", { required: true }),
      { ...buildActionOpts("write", teamId), inviteUserId },
    );
    return jsonResult({ ok: true, ...result });
  }

  if (reactionsActions.has(action)) {
    if (!isActionEnabled("reactions")) {
      throw new Error("Slack reactions are disabled.");
    }
    const target = resolveChannelTarget();
    const { channelId } = target;
    const readOpts = buildActionOpts("read", target.teamId);
    const writeOpts = buildActionOpts("write", target.teamId);
    const messageId = readStringParam(params, "messageId", { required: true });
    if (action === "react") {
      const { emoji, remove, isEmpty } = readReactionParams(params, {
        removeErrorMessage: "Emoji is required to remove a Slack reaction.",
      });
      await assertReadTargetAllowed(target);
      if (remove) {
        await slackActionRuntime.removeSlackReaction(channelId, messageId, emoji, writeOpts);
        return jsonResult({ ok: true, removed: emoji });
      }
      if (isEmpty) {
        const removed = await slackActionRuntime.removeOwnSlackReactions(
          channelId,
          messageId,
          writeOpts,
        );
        return jsonResult({ ok: true, removed });
      }
      await slackActionRuntime.reactSlackMessage(channelId, messageId, emoji, writeOpts);
      return jsonResult({ ok: true, added: emoji });
    }
    await assertReadTargetAllowed(target);
    const limit = readSlackResultLimit(params);
    const reactions = await slackActionRuntime.listSlackReactions(channelId, messageId, readOpts);
    return jsonResult({
      ok: true,
      reactions: reactions?.map((reaction) =>
        reaction.users
          ? Object.assign({}, reaction, { users: reaction.users.slice(0, limit) })
          : reaction,
      ),
    });
  }

  if (messagingActions.has(action)) {
    if (!isActionEnabled("messages")) {
      throw new Error("Slack messages are disabled.");
    }
    const sentResults: SlackSendResult[] = [];
    const buildSendOpts = (destination: string, forceDocument: boolean) => {
      const threadTs = resolveSlackThreadTsFromContext(
        readStringParam(params, "threadTs"),
        destination,
        context,
        { suppressImplicitThread: params.topLevel === true || params.threadTs === null },
      );
      return {
        ...buildActionOpts("write"),
        mediaAccess: context?.mediaAccess,
        mediaLocalRoots: context?.mediaLocalRoots,
        mediaReadFile: context?.mediaReadFile,
        threadTs,
        ...(forceDocument ? { forceDocument: true } : {}),
      };
    };
    const sendSlackMessage = async (
      target: string,
      content: string,
      options: Parameters<typeof slackActionRuntime.sendSlackMessage>[2],
    ) => {
      const replyReference =
        context?.hasRepliedRef && slackContextTargetsMatch(target, context)
          ? context.hasRepliedRef
          : undefined;
      const result = await slackActionRuntime.sendSlackMessage(target, content, {
        ...options,
        ...(replyReference
          ? {
              [SLACK_PRIVATE_ACTION_DELIVERY_RESULT]: () => {
                replyReference.value = true;
              },
            }
          : {}),
      });
      // Injected adapters may expose only their complete delivery result.
      if (replyReference) {
        replyReference.value = true;
      }
      sentResults.push(result);
      return result;
    };
    switch (action) {
      case "openConversation": {
        const teamId =
          readStringParam(params, "teamId") ??
          resolveTrustedCurrentSlackTeamId({ account, context });
        assertSlackDetachedTargetAllowed(account.accountId, teamId);
        const result = await slackActionRuntime.openSlackConversation(
          params.userIds,
          buildActionOpts("write", teamId),
        );
        return jsonResult({ ok: true, ...result });
      }
      case "sendMessage": {
        const to = readStringParam(params, "to", { required: true });
        const target = resolveSlackActionTarget(account, to, context);
        const destination = target.routingTarget;
        const content = readStringParam(params, "content", {
          allowEmpty: true,
        });
        const mediaUrl = readStringParam(params, "mediaUrl");
        const blocks = slackActionRuntime.parseSlackBlocksInput(params.blocks);
        const replyBroadcast = readBooleanParam(params, "replyBroadcast");
        const textIsSlackMrkdwn = readBooleanParam(params, "textIsSlackMrkdwn");
        const textIsSlackPlainText = readBooleanParam(params, "textIsSlackPlainText");
        const forceDocument = readBooleanParam(params, "forceDocument") === true;
        const preparedMessages = context?.preparedMessages;
        const authoredTextPlacement = readStringParam(params, "authoredTextPlacement") as
          | "none"
          | "blocks"
          | "outside-blocks"
          | undefined;
        if (
          authoredTextPlacement &&
          authoredTextPlacement !== "none" &&
          authoredTextPlacement !== "blocks" &&
          authoredTextPlacement !== "outside-blocks"
        ) {
          throw new Error("Slack authoredTextPlacement is invalid.");
        }
        const nativeDataFallbackBaseText = readStringParam(params, "nativeDataFallbackBaseText", {
          allowEmpty: true,
        });
        if (!content && !mediaUrl && !blocks && !preparedMessages?.length) {
          throw new Error("Slack sendMessage requires content, blocks, or mediaUrl.");
        }
        if (replyBroadcast && mediaUrl) {
          throw new Error(
            "Slack replyBroadcast is only supported for text or block thread replies.",
          );
        }
        const baseSendOpts = buildSendOpts(destination, forceDocument);
        const sendOpts = {
          ...baseSendOpts,
          ...(replyBroadcast ? { replyBroadcast } : {}),
          ...(textIsSlackMrkdwn ? { textIsSlackMrkdwn: true } : {}),
          ...(textIsSlackPlainText ? { textIsSlackPlainText: true } : {}),
          ...(authoredTextPlacement ? { authoredTextPlacement } : {}),
          ...(nativeDataFallbackBaseText !== undefined ? { nativeDataFallbackBaseText } : {}),
        };
        const sendContentAndBlocks = async () => {
          if (content && content.length > SLACK_TEXT_LIMIT && !hasSlackNativeDataBlock(blocks)) {
            // Reuse the resolved thread for both sends. Invoking the action twice
            // could consume replyToMode=first and move the full text off-thread.
            const { replyBroadcast: _replyBroadcast, ...blockSendOpts } = sendOpts;
            await sendSlackMessage(destination, "", {
              ...blockSendOpts,
              blocks,
            });
            return await sendSlackMessage(destination, content, sendOpts);
          }
          return await sendSlackMessage(destination, content ?? "", {
            ...sendOpts,
            blocks,
          });
        };
        if (mediaUrl && (preparedMessages?.length || blocks)) {
          await sendSlackMessage(destination, "", {
            ...(preparedMessages?.length ? baseSendOpts : sendOpts),
            mediaUrl,
          });
        }
        if (preparedMessages?.length) {
          for (const [index, message] of preparedMessages.entries()) {
            await sendSlackMessage(destination, message.text, {
              ...baseSendOpts,
              ...message,
              ...(index === 0 && replyBroadcast ? { replyBroadcast: true } : {}),
            });
          }
        } else if (blocks) {
          await sendContentAndBlocks();
        } else {
          await sendSlackMessage(destination, content ?? "", {
            ...sendOpts,
            mediaUrl,
            blocks,
          });
        }

        return jsonResult({ ok: true, result: mergeSlackSendResults(sentResults) });
      }
      case "uploadFile": {
        const to = readStringParam(params, "to", { required: true });
        const target = resolveSlackActionTarget(account, to, context);
        const destination = target.routingTarget;
        const filePath = readStringParam(params, "filePath", {
          required: true,
          trim: false,
        });
        const initialComment = readStringParam(params, "initialComment", {
          allowEmpty: true,
        });
        const filename = readStringParam(params, "filename");
        const title = readStringParam(params, "title");
        const forceDocument = readBooleanParam(params, "forceDocument") === true;
        const replyBroadcast = readBooleanParam(params, "replyBroadcast");
        if (replyBroadcast) {
          throw new Error(
            "Slack replyBroadcast is only supported for text or block thread replies.",
          );
        }
        const result = await sendSlackMessage(destination, initialComment ?? "", {
          ...buildSendOpts(destination, forceDocument),
          mediaUrl: filePath,
          ...(filename ? { uploadFileName: filename } : {}),
          ...(title ? { uploadTitle: title } : {}),
        });

        return jsonResult({ ok: true, result });
      }
      case "editMessage": {
        const target = resolveChannelTarget();
        const { channelId } = target;
        const messageId = readStringParam(params, "messageId", {
          required: true,
        });
        const content = readStringParam(params, "content", {
          allowEmpty: true,
        });
        const blocks = slackActionRuntime.parseSlackBlocksInput(params.blocks);
        if (!content && !blocks) {
          throw new Error("Slack editMessage requires content or blocks.");
        }
        await assertReadTargetAllowed(target);
        const writeOpts = buildActionOpts("write", target.teamId);
        const edit =
          context?.preparedEditText === undefined
            ? slackActionRuntime.editSlackMessage
            : slackActionRuntime.editSlackRenderedMessage;
        await edit(channelId, messageId, context?.preparedEditText ?? content ?? "", {
          ...writeOpts,
          blocks,
        });
        return jsonResult({ ok: true });
      }
      case "deleteMessage": {
        const target = resolveChannelTarget();
        const { channelId } = target;
        const messageId = readStringParam(params, "messageId", {
          required: true,
        });
        await assertReadTargetAllowed(target);
        const writeOpts = buildActionOpts("write", target.teamId);
        await slackActionRuntime.deleteSlackMessage(channelId, messageId, writeOpts);
        return jsonResult({ ok: true });
      }
      case "readMessages": {
        const target = resolveChannelTarget();
        const { channelId } = target;
        const readOpts = buildActionOpts("read", target.teamId);
        const preparedWorkspaceId = await prepareMatrixSlackRead({
          cfg,
          accountId: account.accountId,
          channelId,
          context,
          readOpts,
          resolveConversation: () =>
            slackActionRuntime.resolveSlackConversationInfo({
              cfg,
              accountId: account.accountId,
              channelId,
              teamId: target.teamId,
              operation: "read",
              assertDirectAdapterHandoff: context?.assertDirectAdapterHandoff,
            }),
        });
        await assertReadTargetAllowed(target, {
          allowRequesterMembership: true,
          preparedWorkspaceId,
        });
        const limit = readPositiveIntegerParam(params, "limit", {
          message: "limit must be a positive integer.",
        });
        const before = readStringParam(params, "before");
        const after = readStringParam(params, "after");
        const threadId = readStringParam(params, "threadId");
        const messageId = readStringParam(params, "messageId");
        const result = await slackActionRuntime.readSlackMessages(channelId, {
          ...readOpts,
          limit,
          before,
          after,
          threadId,
          messageId,
        });
        const messages = result.messages.map((message) =>
          withNormalizedTimestamp(message, message.ts),
        );
        return jsonResult({
          ok: true,
          channelId,
          ...(threadId ? { threadId } : {}),
          messages,
          hasMore: result.hasMore,
        });
      }
      case "downloadFile": {
        const fileId = readStringParam(params, "fileId");
        const allThreadFiles = readBooleanParam(params, "allThreadFiles") === true;
        // Set only from a parsed message permalink: stage that message's files.
        const permalinkMessageId = readStringParam(params, "messageId");
        const original = readBooleanParam(params, "original") === true;
        const rawFileIds = params.fileIds;
        const fileIds = Array.isArray(rawFileIds)
          ? rawFileIds.map((value) => (typeof value === "string" ? value.trim() : ""))
          : undefined;
        if (rawFileIds !== undefined && (!fileIds || fileIds.some((value) => !value))) {
          throw new Error("Slack fileIds must be an array of non-empty file ids.");
        }
        const uniqueFileIds = fileIds ? Array.from(new Set(fileIds)) : undefined;
        if (
          [
            Boolean(fileId),
            Boolean(uniqueFileIds),
            allThreadFiles,
            Boolean(permalinkMessageId),
          ].filter(Boolean).length > 1
        ) {
          throw new Error(
            "Slack file download accepts exactly one of fileId, fileIds, or allThreadFiles.",
          );
        }
        if (
          !fileId &&
          (!uniqueFileIds || uniqueFileIds.length === 0) &&
          !allThreadFiles &&
          !permalinkMessageId
        ) {
          throw new Error("Slack file download requires fileId, fileIds, or allThreadFiles.");
        }
        if (uniqueFileIds && uniqueFileIds.length > 20) {
          throw new Error("Slack file download accepts at most 20 unique file ids.");
        }
        const explicitChannelTarget =
          readStringParam(params, "channelId") ?? readStringParam(params, "to");
        const threadId = readStringParam(params, "threadId") ?? readStringParam(params, "replyTo");
        if (allThreadFiles && !threadId) {
          throw new Error("Slack allThreadFiles download requires threadId.");
        }
        const maxBytes = resolveSlackMediaMaxBytes(account.config?.mediaMaxMb);
        const readToken = resolveSlackOperationToken(account, "read");
        const downloadOpts = (teamId?: string) => {
          const opts = buildActionOpts("read", teamId);
          return {
            ...opts,
            ...(readToken && !opts.token ? { token: readToken } : {}),
            maxBytes,
          };
        };
        const resolveFileShareTarget = async (
          sharedFileId: string,
        ): Promise<SlackActionChannelTarget> => {
          // A pasted file permalink names no conversation. Try the current one
          // first, then each conversation the file was shared into that the
          // read gate (including requester membership) admits.
          const teamId = resolveTrustedCurrentSlackTeamId({ account, context });
          const shareIds = await slackActionRuntime.listSlackFileShareChannelIds(
            sharedFileId,
            buildActionOpts("read", teamId),
          );
          const currentId = context?.currentChannelId
            ? resolveSlackActionChannelTarget(account, context.currentChannelId, context).channelId
            : undefined;
          const ordered = [
            ...shareIds.filter((id) => id === currentId),
            ...shareIds.filter((id) => id !== currentId),
          ].slice(0, 10);
          let lastError: unknown;
          for (const candidate of ordered) {
            const candidateTarget = resolveSlackActionChannelTarget(
              account,
              teamId ? formatSlackTarget({ teamId, kind: "channel", id: candidate }) : candidate,
              context,
            );
            try {
              await assertReadTargetAllowed(candidateTarget, { allowRequesterMembership: true });
              return candidateTarget;
            } catch (error) {
              lastError = error;
            }
          }
          throw new Error(
            `Slack file ${sharedFileId} is not shared in any conversation this app and the requester can both read.` +
              (lastError instanceof Error ? ` Last check: ${lastError.message}` : ""),
          );
        };
        const channelTarget = explicitChannelTarget ?? context?.currentChannelId;
        let target: SlackActionChannelTarget;
        if (fileId && !explicitChannelTarget && readBooleanParam(params, "fromPermalink")) {
          target = await resolveFileShareTarget(fileId);
        } else {
          if (!channelTarget) {
            throw new Error(
              "Slack file download requires channelId or to so the read target can be authorized.",
            );
          }
          target = resolveSlackActionChannelTarget(account, channelTarget, context);
          await assertReadTargetAllowed(target, { allowRequesterMembership: true });
        }
        const { channelId } = target;
        const readOpts = buildActionOpts("read", target.teamId);
        const sourceMessages =
          allThreadFiles || permalinkMessageId
            ? await slackActionRuntime.readSlackMessages(channelId, {
                ...readOpts,
                limit: permalinkMessageId ? 1 : 100,
                threadId: threadId ?? undefined,
                ...(permalinkMessageId ? { messageId: permalinkMessageId } : {}),
              })
            : undefined;
        const sourceFileIds = sourceMessages
          ? Array.from(
              new Set(
                sourceMessages.messages.flatMap((message) =>
                  (message.files ?? []).flatMap((file) => (file.id ? [file.id] : [])),
                ),
              ),
            )
          : undefined;
        const batchFileIds = uniqueFileIds ?? sourceFileIds;
        if (batchFileIds && batchFileIds.length > 20) {
          throw new Error(
            `Slack thread contains ${batchFileIds.length} files; bounded batch download supports at most 20.`,
          );
        }
        if (sourceMessages && (!batchFileIds || batchFileIds.length === 0)) {
          return jsonResult({
            ok: true,
            channelId,
            threadId,
            messages: sourceMessages.messages,
            files: [],
          });
        }
        if (batchFileIds) {
          const files = [];
          for (const batchFileId of batchFileIds) {
            let downloaded: Awaited<ReturnType<typeof slackActionRuntime.downloadSlackFile>>;
            try {
              downloaded = await slackActionRuntime.downloadSlackFile(batchFileId, {
                ...downloadOpts(target.teamId),
                channelId,
                threadId: threadId ?? undefined,
              });
            } catch (error) {
              files.push({
                fileId: batchFileId,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              });
              continue;
            }
            if (!downloaded) {
              files.push({
                fileId: batchFileId,
                ok: false,
                error: "File could not be downloaded (not found or inaccessible).",
              });
              continue;
            }
            const [sha256, fileStat] = await Promise.all([
              hashSlackFile(downloaded.path),
              stat(downloaded.path),
            ]);
            const staged = await stageDownloadedSlackFile(downloaded.path, context, batchFileId);
            files.push({
              fileId: batchFileId,
              ok: true,
              path: staged.fsPath,
              contentType: downloaded.contentType,
              size: fileStat.size,
              sha256,
            });
          }
          return jsonResult({
            ok: files.every((file) => file.ok),
            channelId,
            threadId: threadId ?? null,
            ...(sourceMessages ? { messages: sourceMessages.messages } : {}),
            files,
          });
        }
        if (!fileId) {
          throw new Error("Slack single-file download is missing fileId.");
        }
        const downloaded = await slackActionRuntime.downloadSlackFile(fileId, {
          ...downloadOpts(target.teamId),
          channelId,
          threadId,
        });
        if (!downloaded) {
          return jsonResult({
            ok: false,
            error:
              "File could not be downloaded. Confirm the fileId came from the requested Slack channel or explicit thread and that the file is accessible.",
          });
        }
        const staged = await stageDownloadedSlackFile(downloaded.path, context);
        const size = await stat(downloaded.path).then(
          (fileStat) => fileStat.size,
          () => undefined,
        );
        if (original || !downloaded.contentType?.trim().toLowerCase().startsWith("image/")) {
          return jsonResult({
            ok: true,
            fileId,
            channelId,
            path: staged.fsPath,
            contentType: downloaded.contentType,
            size,
            original: true,
            placeholder: downloaded.placeholder,
            media: {
              mediaUrl: staged.workspacePath,
              outbound: false,
              ...(downloaded.contentType ? { contentType: downloaded.contentType } : {}),
            },
          });
        }
        return await imageResultFromFile({
          label: "slack-file",
          // Read the sandbox-visible staged copy (byte-identical to the store
          // original) so the reported path, mediaUrl, and preview bytes agree.
          path: staged.fsPath,
          // The inline image can be downscaled for the model; the staged file is
          // Slack's original upload (url_private_download), byte for byte.
          extraText: `${downloaded.placeholder}\nOriginal file${size === undefined ? "" : ` (${size} bytes)`} saved at ${staged.fsPath}; the inline preview may be resized. Pass original=true to skip the preview.`,
          details: {
            fileId,
            path: staged.fsPath,
            size,
            ...(downloaded.contentType ? { contentType: downloaded.contentType } : {}),
            media: { outbound: false },
          },
          imageSanitization: { maxDimensionPx: cfg.agents?.defaults?.imageMaxDimensionPx },
        });
      }
      default:
        break;
    }
  }

  if (pinActions.has(action)) {
    if (!isActionEnabled("pins")) {
      throw new Error("Slack pins are disabled.");
    }
    const target = resolveChannelTarget();
    const { channelId } = target;
    const readOpts = buildActionOpts("read", target.teamId);
    const writeOpts = buildActionOpts("write", target.teamId);
    if (action === "pinMessage" || action === "unpinMessage") {
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      await assertReadTargetAllowed(target);
      const updatePin =
        action === "pinMessage"
          ? slackActionRuntime.pinSlackMessage
          : slackActionRuntime.unpinSlackMessage;
      await updatePin(channelId, messageId, writeOpts);
      return jsonResult({ ok: true });
    }
    await assertReadTargetAllowed(target);
    const pins = await slackActionRuntime.listSlackPins(channelId, readOpts);
    pins.length = Math.min(pins.length, readPositiveIntegerParam(params, "limit") ?? pins.length);
    const normalizedPins = pins.map((pin) => {
      const message = pin.message && withNormalizedTimestamp(pin.message, pin.message.ts);
      return message ? Object.assign({}, pin, { message }) : pin;
    });
    return jsonResult({ ok: true, pins: normalizedPins });
  }

  if (action === "memberInfo") {
    if (!isActionEnabled("memberInfo")) {
      throw new Error("Slack member info is disabled.");
    }
    const userId = readStringParam(params, "userId", { required: true });
    assertSlackMemberInfoAllowed({ account, context, userId });
    const teamId = resolveTrustedCurrentSlackTeamId({ account, context });
    assertSlackDetachedTargetAllowed(account.accountId, teamId);
    const info = await slackActionRuntime.getSlackMemberInfo(
      userId,
      buildActionOpts("read", teamId),
    );
    return jsonResult({ ok: true, info });
  }

  if (action === "emojiList") {
    if (!isActionEnabled("emojiList")) {
      throw new Error("Slack emoji list is disabled.");
    }
    const limit = readSlackResultLimit(params);
    const teamId = resolveTrustedCurrentSlackTeamId({ account, context });
    assertSlackDetachedTargetAllowed(account.accountId, teamId);
    const result = await slackActionRuntime.listSlackEmojis(buildActionOpts("read", teamId));
    const emojis = Object.entries(result.emoji ?? {})
      .toSorted(([left], [right]) => left.localeCompare(right))
      .slice(0, limit)
      .map(([name, value]) =>
        value.startsWith("alias:")
          ? { name, identifier: name, aliasOf: value.slice("alias:".length) }
          : { name, identifier: name },
      );
    return jsonResult({ ok: true, emojis });
  }

  throw new Error(`Unknown action: ${action}`);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

export type { StagedSlackFile } from "./action-files.js";
