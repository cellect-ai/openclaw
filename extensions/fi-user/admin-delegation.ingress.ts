import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  SOURCE_REPLY_TTL_MS,
  MATRIX_USER_ID,
  type Proof,
  remember,
  type Inbound,
} from "./admin-delegation.shared.js";
import { configFromRuntime, FI_USER_AGENT_ID, matrixConnection } from "./fi-delegation.js";
import { onBehalfOfRequester, type OnBehalfOfRequester } from "./on-behalf-of.js";
import { forgetProjectedMatrixSession } from "./projected-matrix-runs.js";

export function createAdminDelegationIngress(
  api: OpenClawPluginApi,
  fiUserReplies: Map<
    string,
    Map<string, { matrixUserId: string; roomId: string; accountId?: string }>
  >,
  fiUserTainted: Set<string>,
) {
  /** Only Matrix's native, source-authorized ingress can supply this event tuple.
   * It grants no Fi permissions; verified dispatch and exact run/event matching
   * below still decide whether it can prove this turn. */
  const sourceReplyAdmission = (message: Inbound, sessionKey: string) => {
    const proof = message.channelContext?.chat?.sourceReplyAdmission;
    if (!isRecord(proof)) {
      return undefined;
    }
    const accountId = typeof proof.accountId === "string" ? proof.accountId : undefined;
    return proof.version === 1 &&
      typeof proof.sessionKey === "string" &&
      proof.sessionKey.toLowerCase() === sessionKey &&
      proof.senderId === message.senderId?.trim() &&
      proof.senderId === message.channelContext?.sender?.id &&
      proof.roomId === message.channelContext?.chat?.id &&
      proof.eventId === message.messageId &&
      proof.eventId === message.channelContext?.chat?.eventId &&
      typeof proof.eventId === "string" &&
      proof.eventId.startsWith("$") &&
      accountId !== undefined &&
      accountId === message.accountId &&
      matrixConnection(configFromRuntime(api), accountId) !== undefined &&
      typeof proof.authorizedAt === "number" &&
      Number.isSafeInteger(proof.authorizedAt) &&
      proof.authorizedAt <= Date.now() &&
      proof.authorizedAt > Date.now() - SOURCE_REPLY_TTL_MS &&
      typeof proof.roomId === "string" &&
      proof.roomId.startsWith("!")
      ? { roomId: proof.roomId, accountId }
      : undefined;
  };

  const FI_USER_SOURCE_SESSION = new RegExp(`^agent:${FI_USER_AGENT_ID}:slack:(?:channel|group):`);

  /**
   * A message for a Fi-user Slack session. Only a homeserver-verified reply that
   * Fi's source guard currently allows for this exact person and session is
   * remembered; anyone else's message voids what is pending and running there.
   */
  const fiUserInbound = (message: Inbound, dispatch: boolean): void => {
    const sessionKey = message.sessionKey?.toLowerCase();
    if (!sessionKey || !FI_USER_SOURCE_SESSION.test(sessionKey)) {
      return;
    }
    const sender = message.senderId?.trim() ?? "";
    const allowed = sourceReplyAdmission(message, sessionKey);
    const proven =
      (message.channel === "matrix" || message.channel === "slack") &&
      MATRIX_USER_ID.test(sender) &&
      allowed !== undefined;
    const pending = fiUserReplies.get(sessionKey);
    if (!proven || (dispatch && message.senderAuthentication !== "verified")) {
      fiUserReplies.delete(sessionKey);
      forgetProjectedMatrixSession(sessionKey);
      fiUserTainted.add(sessionKey);
      return;
    }
    for (const [eventId, reply] of pending ?? []) {
      if (reply.matrixUserId !== sender) {
        pending!.delete(eventId);
        fiUserTainted.add(sessionKey);
      }
    }
    forgetProjectedMatrixSession(sessionKey, sender);
    if (!dispatch || typeof message.isGroup !== "boolean" || !message.messageId?.startsWith("$")) {
      return;
    }
    const account = message.accountId?.trim();
    const replies = pending ?? new Map();
    replies.set(message.messageId, {
      matrixUserId: sender,
      roomId: allowed.roomId,
      ...(account && matrixConnection(configFromRuntime(api), account)
        ? { accountId: account }
        : {}),
    });
    remember(fiUserReplies, sessionKey, replies);
  };

  /**
   * Who an inbound message for an admin session is from. A reply in a Slack
   * session's Matrix projection is a Matrix person even when the host labels
   * the message with the session's channel; only Fi's current source-guard
   * allowance for this exact person and session makes such a sender one.
   */
  const inboundRequester = (
    sessionKey: string,
    message: Inbound,
  ): OnBehalfOfRequester | undefined => {
    const direct = onBehalfOfRequester(message);
    if (direct) {
      return direct;
    }
    const sender = message.senderId?.trim() ?? "";
    const allowed = sourceReplyAdmission(message, sessionKey);
    return /^agent:[^:]+:slack:(?:channel|group):/.test(sessionKey) &&
      MATRIX_USER_ID.test(sender) &&
      allowed !== undefined
      ? { requester_matrix_user_id: sender }
      : undefined;
  };

  /**
   * The sender a verified dispatched message proves for the admin agent's
   * session, by the session key the host routed (compared in lower case):
   * - Slack DMs bind the peer. Channels/threads additionally bind the native
   *   message timestamp and the run's host-owned channel context below.
   * - Matrix: `agent:<admin>:matrix:…`, whose key does not say what kind of
   *   room it is, so the Matrix monitor must have classified the message as
   *   direct or as a room's. Either proves its sender for that one homeserver
   *   event only.
   */
  const provenSender = (
    adminAgentId: string,
    sessionKey: string,
    message: Inbound,
  ): Proof | undefined => {
    const prefix = `agent:${adminAgentId.toLowerCase()}:`;
    const requester = inboundRequester(sessionKey, message);
    if (!requester || !sessionKey.startsWith(prefix)) {
      return undefined;
    }
    const rest = sessionKey.slice(prefix.length);
    const sender = JSON.stringify(requester);
    if ("requester_slack_user_id" in requester) {
      if (rest === `slack:direct:${requester.requester_slack_user_id.toLowerCase()}`) {
        return { sender };
      }
      return message.isGroup === true &&
        /^slack:(?:channel|group):[cg][a-z0-9]+(?::thread:\d+\.\d+)?$/.test(rest) &&
        typeof message.messageId === "string" &&
        /^\d+\.\d+$/.test(message.messageId)
        ? { sender, eventId: message.messageId }
        : undefined;
    }
    if (!("requester_matrix_user_id" in requester)) {
      return undefined;
    }
    if (/^slack:(?:channel|group):/.test(rest)) {
      // A reply in a Slack thread's Matrix projection. The Matrix channel
      // admits it only after Fi's source guard allows this person to continue
      // this session from that room; that answer is the proof. A Slack DM's
      // projection has no local peer check here, so it proves nothing.
      const allowed = sourceReplyAdmission(message, sessionKey);
      return allowed && typeof message.isGroup === "boolean" && message.messageId?.startsWith("$")
        ? {
            sender,
            eventId: message.messageId,
            sourceRoomId: allowed.roomId,
            sourceMatrixUserId: requester.requester_matrix_user_id,
            // Only a configured Matrix account names the Fi environment; a Slack
            // account the host may report for the session never does.
            sourceAccountId: allowed.accountId,
          }
        : undefined;
    }
    if (!rest.startsWith("matrix:")) {
      return undefined;
    }
    return typeof message.isGroup === "boolean" && message.messageId?.startsWith("$")
      ? { sender, eventId: message.messageId }
      : undefined;
  };
  return { sourceReplyAdmission, fiUserInbound, inboundRequester, provenSender };
}
