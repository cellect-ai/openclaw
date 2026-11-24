import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateTalkSessionAcknowledgeMarkParams,
  validateTalkSessionAnnounceParams,
  validateTalkSessionAppendAudioParams,
  validateTalkSessionCancelOutputParams,
  validateTalkSessionCloseParams,
  validateTalkSessionSteerParams,
  validateTalkSessionSubmitToolResultParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import { captureGatewayOperatorRunAuthority } from "../../operator-run-authority.js";
import type { GatewayRequestHandlers } from "../../server-methods/types.js";
import { defineValidatedGatewayHandler } from "../../server-methods/validation.js";
import { resolveTalkAgentConsultAuthority } from "../client-tool-authority.js";
import { getTalkHandoff, revokeTalkHandoff } from "../handoff.js";
import { announceTalkRealtimeRelayAnswer, normalizeTalkAnswerText } from "../relay/announce.js";
import {
  acknowledgeTalkRealtimeRelayMark,
  cancelTalkRealtimeRelayTurn,
  sendTalkRealtimeRelayAudio,
  steerTalkRealtimeRelayAgentRun,
  stopTalkRealtimeRelaySession,
  submitTalkRealtimeRelayToolResult,
} from "../relay/operations.js";
import { talkRequestError } from "../request-error.js";
import { broadcastTalkRoomEvents } from "../session-config.js";
import {
  forgetUnifiedTalkSession,
  getUnifiedTalkSession,
  requireUnifiedTalkSessionConn,
} from "../session-registry.js";
import {
  sendTalkTranscriptionRelayAudio,
  stopTalkTranscriptionRelaySession,
} from "../transcription-relay.js";
import { respondInvalidRequest, respondOk, talkSessionError } from "./session-responses.js";

function canCloseManagedRoomSession(
  session: { handoffId: string },
  connId: string | undefined,
): boolean {
  const handoff = getTalkHandoff(session.handoffId);
  return !handoff?.room.activeClientId || handoff.room.activeClientId === connId;
}
function managedRoomOwnershipError(action: string) {
  return errorShape(
    ErrorCodes.INVALID_REQUEST,
    `talk.session.${action} requires the active managed-room connection`,
  );
}
export const talkSessionControlHandlers: GatewayRequestHandlers = {
  "talk.session.appendAudio": defineValidatedGatewayHandler(
    "talk.session.appendAudio",
    validateTalkSessionAppendAudioParams,
    async ({ params, respond, client }) => {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind === "realtime-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        await sendTalkRealtimeRelayAudio({
          relaySessionId: session.relaySessionId,
          connId,
          audioBase64: params.audioBase64,
          timestamp: params.timestamp,
        });
      } else if (session.kind === "transcription-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        sendTalkTranscriptionRelayAudio({
          transcriptionSessionId: session.transcriptionSessionId,
          connId,
          audioBase64: params.audioBase64,
        });
      } else {
        respondInvalidRequest(
          respond,
          "talk.session.appendAudio is not supported for managed-room sessions",
        );
        return;
      }
      respondOk(respond);
    },
    talkSessionError,
  ),
  "talk.session.cancelOutput": defineValidatedGatewayHandler(
    "talk.session.cancelOutput",
    validateTalkSessionCancelOutputParams,
    async ({ params, respond, client }) => {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind !== "realtime-relay") {
        respondInvalidRequest(respond, "talk.session.cancelOutput requires realtime relay");
        return;
      }
      const connId = requireUnifiedTalkSessionConn(session, client?.connId);
      const result = await cancelTalkRealtimeRelayTurn({
        relaySessionId: session.relaySessionId,
        connId,
        reason: normalizeOptionalString(params.reason) ?? "output-cancelled",
        turnId: normalizeOptionalString(params.turnId),
      });
      respondOk(respond, { ok: true, ...result });
    },
    talkSessionError,
  ),
  "talk.session.acknowledgeMark": defineValidatedGatewayHandler(
    "talk.session.acknowledgeMark",
    validateTalkSessionAcknowledgeMarkParams,
    ({ params, respond, client }) => {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind !== "realtime-relay") {
        respondInvalidRequest(respond, "talk.session.acknowledgeMark requires realtime relay");
        return;
      }
      acknowledgeTalkRealtimeRelayMark({
        relaySessionId: session.relaySessionId,
        connId: requireUnifiedTalkSessionConn(session, client?.connId),
        markName: params.markName,
      });
      respondOk(respond);
    },
    (error) => talkRequestError(error, "legacy-relay"),
  ),
  "talk.session.submitToolResult": defineValidatedGatewayHandler(
    "talk.session.submitToolResult",
    validateTalkSessionSubmitToolResultParams,
    async ({ params, respond, client }) => {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind !== "realtime-relay") {
        respondInvalidRequest(
          respond,
          "talk.session.submitToolResult is only supported for realtime relay sessions",
        );
        return;
      }
      const connId = requireUnifiedTalkSessionConn(session, client?.connId);
      await submitTalkRealtimeRelayToolResult({
        relaySessionId: session.relaySessionId,
        connId,
        callId: params.callId,
        result: params.result,
        options: params.options,
      });
      respondOk(respond);
    },
    talkSessionError,
  ),
  "talk.session.steer": defineValidatedGatewayHandler(
    "talk.session.steer",
    validateTalkSessionSteerParams,
    async ({
      params,
      respond,
      client,
      context,
      hasCurrentClientAuthority,
      sessionMutationAuthorization,
    }) => {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind === "realtime-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        const assertCurrent = () => {
          sessionMutationAuthorization?.assertCurrent();
          if (
            getUnifiedTalkSession(params.sessionId) !== session ||
            (sessionMutationAuthorization?.talkSessionTarget &&
              sessionMutationAuthorization.talkSessionTarget !== session.sessionTarget)
          ) {
            throw new Error("Talk session changed while steering the agent run");
          }
        };
        assertCurrent();
        const captured = await captureGatewayOperatorRunAuthority({
          client: client ?? null,
          context,
          hasCurrentClientAuthority,
        });
        try {
          const result = await steerTalkRealtimeRelayAgentRun({
            relaySessionId: session.relaySessionId,
            connId,
            authority: {
              ...resolveTalkAgentConsultAuthority(client?.connect?.scopes, client),
              operatorAuthority: captured?.authority,
            },
            sessionKey: normalizeOptionalString(params.sessionKey),
            text: params.text,
            mode: params.mode,
            assertCurrent,
          });
          respondOk(respond, result);
        } finally {
          captured?.release();
        }
        return;
      }
      if (session.kind === "transcription-relay") {
        respondInvalidRequest(respond, "talk.session.steer requires an agent-backed Talk session");
        return;
      }
      // Managed rooms have no client admission route; creating a handoff grants no run authority.
      if (client?.connId) {
        getTalkHandoff(session.handoffId);
      }
      respondInvalidRequest(
        respond,
        "talk.session.steer requires the active managed-room connection",
      );
    },
    talkSessionError,
  ),
  "talk.session.announce": defineValidatedGatewayHandler(
    "talk.session.announce",
    validateTalkSessionAnnounceParams,
    async ({ params, respond, client }) => {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind !== "realtime-relay") {
        respondInvalidRequest(respond, "talk.session.announce requires realtime relay");
        return;
      }
      const connId = requireUnifiedTalkSessionConn(session, client?.connId);
      const text = normalizeTalkAnswerText(params.text);
      if (!text) {
        respondInvalidRequest(respond, "talk.session.announce requires non-empty text");
        return;
      }
      const outcome = await announceTalkRealtimeRelayAnswer({
        relaySessionId: session.relaySessionId,
        connId,
        text,
      });
      if (outcome === "unsupported") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "talk.session.announce is not supported by this realtime voice provider",
            { details: { code: "announce_unsupported" } },
          ),
        );
        return;
      }
      if (outcome === "unavailable") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "Realtime voice is not accepting input; retry", {
            retryable: true,
            details: { code: "announce_unavailable" },
          }),
        );
        return;
      }
      respondOk(respond);
    },
    talkSessionError,
  ),
  "talk.session.close": defineValidatedGatewayHandler(
    "talk.session.close",
    validateTalkSessionCloseParams,
    async ({ params, respond, client, context }) => {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind === "realtime-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        await stopTalkRealtimeRelaySession({
          relaySessionId: session.relaySessionId,
          connId,
          disposition: params.disposition,
        });
      } else if (session.kind === "transcription-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        await stopTalkTranscriptionRelaySession({
          transcriptionSessionId: session.transcriptionSessionId,
          connId,
          discard: params.discard,
        });
      } else {
        if (!canCloseManagedRoomSession(session, client?.connId)) {
          respond(false, undefined, managedRoomOwnershipError("close"));
          return;
        }
        const result = revokeTalkHandoff(session.handoffId);
        broadcastTalkRoomEvents(context, result.activeClientId, {
          handoffId: session.handoffId,
          roomId: session.roomId,
          events: result.events,
        });
      }
      // Transcription owns its final drain and accepts discard until that drain ends.
      if (session.kind !== "transcription-relay") {
        forgetUnifiedTalkSession(params.sessionId);
      }
      respondOk(respond);
    },
    talkSessionError,
  ),
};
