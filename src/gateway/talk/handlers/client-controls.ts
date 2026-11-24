import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateTalkClientCloseParams,
  validateTalkClientSayParams,
  validateTalkClientSteerParams,
  validateTalkClientTranscriptParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import { createPluginRuntime } from "../../../plugins/runtime/index.js";
import { controlTalkAgentRun } from "../../../talk/agent-run-control.js";
import {
  appendClientVoiceTranscript,
  closeClientVoiceSession,
} from "../../../talk/client-voice-session.js";
import { captureGatewayOperatorRunAuthority } from "../../operator-run-authority.js";
import { readGatewayRequestMutationAuthority } from "../../server-methods/session-mutation-guards.js";
import type { GatewayRequestHandlers } from "../../server-methods/types.js";
import { defineValidatedGatewayHandler } from "../../server-methods/validation.js";
import { isWebchatSessionAllowed } from "../../webchat-agent-authorization.js";
import { formatForLog } from "../../ws-log.js";
import { prepareTalkClientControlAuthority } from "../client-agent-consult.js";
import {
  closeTalkClientGatewayControlSession,
  sendTalkClientGatewayControlSpeech,
} from "../client-gateway-control.js";
import { resolveTalkAgentConsultAuthority } from "../client-tool-authority.js";
import { createTalkRunCancel } from "../realtime-run-control.js";
import { talkRequestError } from "../request-error.js";
import { resolveOwnedActiveTalkRunTarget } from "../run-ownership.js";
import { prepareTalkSessionTarget, requirePreparedTalkSessionTarget } from "../session-target.js";
import { unregisterTalkVoiceSession } from "../voice-selection.js";
import { forgetLegacyVoiceBinding } from "./client-legacy-voice-bindings.js";
import { prepareTalkMatrixBrowserRefusal } from "./matrix-browser-talk-authorization.js";
const clientMutationError = (error: unknown) =>
  errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(error));
export const talkClientControlHandlers: GatewayRequestHandlers = {
  "talk.client.say": defineValidatedGatewayHandler(
    "talk.client.say",
    validateTalkClientSayParams,
    (request) => {
      const { params, respond } = request;
      if (!params.text.trim() || Buffer.byteLength(params.text, "utf8") > 1024) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "text must contain 1–1024 UTF-8 bytes of speech"),
        );
        return;
      }
      const target = requirePreparedTalkSessionTarget(
        request.sessionMutationAuthorization?.talkSessionTarget,
      );
      request.sessionMutationAuthorization?.assertCurrent();
      readGatewayRequestMutationAuthority(request).assertCurrent();
      target.assertCurrent(request.context.getRuntimeConfig());
      sendTalkClientGatewayControlSpeech({
        voiceSessionId: params.voiceSessionId,
        sessionTarget: target,
        connId: request.client?.connId,
        text: params.text,
      });
      respond(true, { accepted: true }, undefined);
    },
    talkRequestError,
  ),
  "talk.client.transcript": defineValidatedGatewayHandler(
    "talk.client.transcript",
    validateTalkClientTranscriptParams,
    async ({ params, respond, context, client, sessionMutationAuthorization }) => {
      const config = context.getRuntimeConfig();
      if (
        !isWebchatSessionAllowed({ cfg: config, client, sessionKey: params.sessionKey }) ||
        (await prepareTalkMatrixBrowserRefusal({
          cfg: config,
          client,
          sessionKey: params.sessionKey,
          authorizedByBinding: false,
        }))
      ) {
        throw new Error("Matrix Talk sessions require an authorized binding");
      }

      const target =
        sessionMutationAuthorization?.talkSessionTarget ??
        (await prepareTalkSessionTarget(config, params.sessionKey));
      sessionMutationAuthorization?.assertCurrent();
      await appendClientVoiceTranscript({
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        sessionTarget: { sessionKey: target.canonicalKey, storePath: target.storePath },
        voiceSessionId: params.voiceSessionId,
        entryId: params.entryId,
        role: params.role,
        text: params.text,
        ...(params.timestamp !== undefined ? { timestamp: params.timestamp } : {}),
        config,
      });
      respond(true, { ok: true }, undefined);
    },
    clientMutationError,
  ),
  "talk.client.close": defineValidatedGatewayHandler(
    "talk.client.close",
    validateTalkClientCloseParams,
    async ({ params, respond, context, client, sessionMutationAuthorization }) => {
      if (
        await closeTalkClientGatewayControlSession({
          voiceSessionId: params.voiceSessionId,
          sessionKey: params.sessionKey,
          connId: normalizeOptionalString(client?.connId),
        })
      ) {
        respond(true, { ok: true }, undefined);
        return;
      }
      const config = context.getRuntimeConfig();
      if (
        !isWebchatSessionAllowed({ cfg: config, client, sessionKey: params.sessionKey }) ||
        (await prepareTalkMatrixBrowserRefusal({
          cfg: config,
          client,
          sessionKey: params.sessionKey,
          authorizedByBinding: false,
        }))
      ) {
        throw new Error("Matrix Talk sessions require an authorized binding");
      }

      const { agentId } =
        sessionMutationAuthorization?.talkSessionTarget ??
        (await prepareTalkSessionTarget(config, params.sessionKey));
      sessionMutationAuthorization?.assertCurrent();
      await closeClientVoiceSession({
        agentId,
        sessionKey: params.sessionKey,
        voiceSessionId: params.voiceSessionId,
        config,
        expectedOrigin: "client",
      });
      const connId = normalizeOptionalString(client?.connId);
      if (connId) {
        unregisterTalkVoiceSession(params.voiceSessionId, connId, agentId);
        forgetLegacyVoiceBinding(connId, params.sessionKey, params.voiceSessionId);
      }
      respond(true, { ok: true }, undefined);
    },
    clientMutationError,
  ),
  "talk.client.steer": defineValidatedGatewayHandler(
    "talk.client.steer",
    validateTalkClientSteerParams,
    async ({
      params,
      respond,
      client,
      context,
      sessionMutationAuthorization,
      hasCurrentClientAuthority,
    }) => {
      const target =
        sessionMutationAuthorization?.talkSessionTarget ??
        (await prepareTalkSessionTarget(context.getRuntimeConfig(), params.sessionKey));
      const runTarget = resolveOwnedActiveTalkRunTarget({
        clientConnId: client?.connId,
        sessionTarget: target,
        scope: { kind: "session" },
        assertCurrent: sessionMutationAuthorization?.assertCurrent,
      });
      if (runTarget === null) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "talk.client.steer requires an active browser-owned Talk run",
          ),
        );
        return;
      }
      const captured = await captureGatewayOperatorRunAuthority({
        client: client ?? null,
        context,
        hasCurrentClientAuthority,
      });
      try {
        const result = await controlTalkAgentRun({
          sessionKey: target.canonicalKey,
          runTarget,
          getToolAuthorityOverlayAsync: () =>
            prepareTalkClientControlAuthority({
              config: context.getRuntimeConfig(),
              agentRuntime: createPluginRuntime().agent,
              sessionTarget: target,
              source: runTarget.toolAuthoritySource,
              authority: {
                ...resolveTalkAgentConsultAuthority(client?.connect?.scopes, client),
                operatorAuthority: captured?.authority,
              },
            }),
          text: params.text,
          mode: params.mode,
          cancelRun: createTalkRunCancel({
            context,
            sessionTarget: target,
            connId: client?.connId ?? "",
            assertCurrent: sessionMutationAuthorization?.assertCurrent,
          }),
        });
        respond(true, result, undefined);
      } finally {
        captured?.release();
      }
    },
    talkRequestError,
  ),
};
