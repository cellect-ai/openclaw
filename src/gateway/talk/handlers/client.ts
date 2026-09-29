// Talk client methods create browser-owned realtime voice sessions and route
// client tool calls back into OpenClaw agent consult/control flows.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateTalkClientCloseParams,
  validateTalkClientSteerParams,
  validateTalkClientToolCallParams,
  validateTalkClientTranscriptParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import { AgentSelectionRequiredError } from "../../../agents/agent-scope.js";
import { createPluginRuntime } from "../../../plugins/runtime/index.js";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  parseRealtimeVoiceAgentConsultArgs,
} from "../../../talk/agent-consult-tool.js";
import { controlRealtimeVoiceAgentRun } from "../../../talk/agent-run-control.js";
import {
  authorizeCurrentClientVoiceConfirmation,
  authorizeClientVoiceConfirmation,
  bindAuthorizedClientVoiceConfirmation,
  type ClientVoiceConfirmationGrant,
} from "../../../talk/client-voice-confirmation.js";
import {
  appendClientVoiceTranscript,
  assertClientVoiceSessionOpen,
  closeClientVoiceSession,
  createOrResumeClientVoiceSession,
  ensureClientVoiceAgentSessionEntry,
  registerClientVoiceConsultRun,
  resolveClientVoiceSessionOrigin,
  resolveOpenClientVoiceSessionId,
} from "../../../talk/client-voice-session.js";
import { isUnauthorizedRawMatrixBrowserSession } from "../../matrix-browser-session-authorization.js";
import {
  authorizeGatewaySessionCreation,
  resolveSandboxedSessionCreation,
} from "../../operator-role-policy.js";
import type { GatewayRequestHandlers } from "../../server-methods/types.js";
import { assertValidParams } from "../../server-methods/validation.js";
import { SessionMutationAuthorizationChangedError } from "../../session-mutation-authorization-error.js";
import { isWebchatSessionAllowed } from "../../webchat-agent-authorization.js";
import { formatForLog } from "../../ws-log.js";
import { startTalkRealtimeAgentConsult } from "../agent-consult.js";
import { prepareTalkClientControlAuthority } from "../client-agent-consult.js";
import {
  closeTalkClientGatewayControlSession,
  resolveTalkAgentConsultAuthority,
} from "../client-gateway-control.js";
import {
  ensureTalkRealtimeRelayVoiceSession,
  flushTalkRealtimeRelayVoiceWrites,
} from "../relay/index.js";
import { resolveOwnedTalkRealtimeRelaySession } from "../relay/state.js";
import { resolveOwnedActiveTalkRunTarget } from "../run-ownership.js";
import { prepareTalkSessionTarget, requirePreparedTalkSessionTarget } from "../session-target.js";
import { unregisterTalkVoiceSession } from "../voice-selection.js";
import { createTalkClient } from "./client-create.js";
import {
  forgetLegacyVoiceBinding,
  readLegacyVoiceBinding,
  rememberLegacyVoiceBinding,
} from "./client-legacy-voice-bindings.js";

/**
 * Gateway methods for browser-owned realtime Talk sessions.
 *
 * These handlers create provider browser sessions and bridge client-owned tool
 * calls back into OpenClaw agent consult runs.
 */
export const talkClientHandlers: GatewayRequestHandlers = {
  "talk.client.create": createTalkClient,
  "talk.client.toolCall": async (request) => {
    const { params, respond } = request;
    if (
      !assertValidParams(params, validateTalkClientToolCallParams, "talk.client.toolCall", respond)
    ) {
      return;
    }
    if (params.name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unsupported realtime Talk tool: ${params.name}`),
      );
      return;
    }

    const relaySessionId = normalizeOptionalString(params.relaySessionId);
    const connId = normalizeOptionalString(request.client?.connId);
    const providedSessionKey = normalizeOptionalString(params.sessionKey);
    const relay = relaySessionId
      ? resolveOwnedTalkRealtimeRelaySession(relaySessionId, connId)
      : undefined;
    if (
      relaySessionId &&
      (!relay ||
        (providedSessionKey &&
          relay.sessionTarget.canonicalKey !== providedSessionKey &&
          relay.sessionTarget.sessionKey !== providedSessionKey) ||
        !connId ||
        relay.connId !== connId)
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Talk relay is unavailable"),
      );
      return;
    }
    const sessionKey =
      (!providedSessionKey && relay && relay.connId === connId
        ? relay.sessionTarget.canonicalKey
        : undefined) ?? providedSessionKey;
    if (!sessionKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Talk session key is required"),
      );
      return;
    }
    const config = request.context.getRuntimeConfig();
    const target = requirePreparedTalkSessionTarget(
      request.sessionMutationAuthorization?.talkSessionTarget,
    );
    request.sessionMutationAuthorization?.assertCurrent();
    if (
      !isWebchatSessionAllowed({ cfg: config, client: request.client, sessionKey }) ||
      isUnauthorizedRawMatrixBrowserSession({
        cfg: config,
        clientInfo: request.client?.connect?.client,
        pairedClientId: request.client?.pairedClientId,
        sessionKey,
        authorizedByBinding: Boolean(
          connId &&
          relay?.matrixRoute &&
          relay.connId === connId &&
          relay.sessionTarget.canonicalKey === sessionKey,
        ),
      })
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Matrix Talk sessions require an authorized binding",
        ),
      );
      return;
    }
    const agentId = target.agentId;
    const assertCommitAllowed = () => {
      request.sessionMutationCommitGuard?.();
      request.sessionMutationAuthorization?.assertCurrent();
      if (
        relaySessionId &&
        resolveOwnedTalkRealtimeRelaySession(relaySessionId, connId) !== relay
      ) {
        throw new Error("Talk relay is unavailable");
      }
    };
    const creationError = authorizeGatewaySessionCreation({
      cfg: config,
      client: request.client,
      agentId,
    });
    if (creationError) {
      respond(false, undefined, creationError);
      return;
    }
    const explicitVoiceSessionId = normalizeOptionalString(params.voiceSessionId);
    if (relaySessionId && explicitVoiceSessionId && explicitVoiceSessionId !== relaySessionId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "relaySessionId and voiceSessionId must match"),
      );
      return;
    }
    let confirmationGrant: ClientVoiceConfirmationGrant | undefined;
    let voiceSessionId: string;
    try {
      // Shipped clients may consult without ever creating a voice session (old app,
      // restarted gateway, ambiguous open records). Implicitly create one instead of
      // erroring so confirmation and mutation evidence stay always-on.
      voiceSessionId =
        explicitVoiceSessionId ??
        relaySessionId ??
        (connId ? readLegacyVoiceBinding(connId, sessionKey) : undefined) ??
        resolveOpenClientVoiceSessionId({ agentId, sessionKey }) ??
        createOrResumeClientVoiceSession({
          agentId,
          sessionKey,
          origin: "client",
        });
      if (relaySessionId && connId) {
        await ensureClientVoiceAgentSessionEntry({
          agentId,
          sessionKey,
          creation: resolveSandboxedSessionCreation(request.client, config),
          assertCommitAllowed,
        });
        assertCommitAllowed();
        ensureTalkRealtimeRelayVoiceSession({
          relaySessionId,
          connId,
          sessionKey,
        });
        await flushTalkRealtimeRelayVoiceWrites({ relaySessionId, connId });
      }
      const parsedArgs = parseRealtimeVoiceAgentConsultArgs(params.args ?? {});
      const origin = assertClientVoiceSessionOpen({
        agentId,
        sessionKey,
        voiceSessionId,
      });
      if (origin === "relay" && (!relaySessionId || !connId)) {
        throw new Error(
          "relay-owned voice sessions require relaySessionId and connection ownership",
        );
      }
      confirmationGrant = parsedArgs.confirmationId
        ? authorizeClientVoiceConfirmation({
            agentId,
            voiceSessionId,
            confirmationId: parsedArgs.confirmationId,
          })
        : authorizeCurrentClientVoiceConfirmation({ agentId, voiceSessionId });
      // Only validated calls may replace the legacy client's connection binding.
      if (connId && !relaySessionId) {
        rememberLegacyVoiceBinding({ connId, sessionKey, voiceSessionId });
      }
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
      return;
    }

    const result = await startTalkRealtimeAgentConsult(request, {
      sessionTarget: target,
      assertCommitAllowed,
      callId: params.callId,
      args: params.args ?? {},
      relaySessionId: normalizeOptionalString(params.relaySessionId),
      connId,
      matrixRoute: connId && relay?.connId === connId ? relay.matrixRoute : undefined,
      onRunStarted: (runId) => {
        registerClientVoiceConsultRun({
          agentId,
          sessionKey,
          voiceSessionId,
          runId,
          config: request.context.getRuntimeConfig(),
        });
        if (confirmationGrant) {
          bindAuthorizedClientVoiceConfirmation({ grant: confirmationGrant, runId });
        }
      },
    });
    if (!result.ok) {
      respond(false, undefined, result.error);
      return;
    }
    respond(
      true,
      {
        runId: result.runId,
        idempotencyKey: result.idempotencyKey,
        agentId,
        agentSessionKey: target.canonicalKey,
      },
      undefined,
    );
  },
  "talk.client.transcript": async ({
    params,
    respond,
    context,
    client,
    sessionMutationAuthorization,
  }) => {
    if (
      !assertValidParams(
        params,
        validateTalkClientTranscriptParams,
        "talk.client.transcript",
        respond,
      )
    ) {
      return;
    }
    try {
      const config = context.getRuntimeConfig();
      const target =
        sessionMutationAuthorization?.talkSessionTarget ??
        prepareTalkSessionTarget(config, params.sessionKey);
      sessionMutationAuthorization?.assertCurrent();
      if (
        !isWebchatSessionAllowed({ cfg: config, client, sessionKey: params.sessionKey }) ||
        isUnauthorizedRawMatrixBrowserSession({
          cfg: config,
          clientInfo: client?.connect?.client,
          pairedClientId: client?.pairedClientId,
          sessionKey: params.sessionKey,
          authorizedByBinding: false,
        })
      ) {
        throw new Error("Matrix Talk sessions require an authorized binding");
      }
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
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
    }
  },
  "talk.client.close": async ({
    params,
    respond,
    context,
    client,
    sessionMutationAuthorization,
  }) => {
    if (!assertValidParams(params, validateTalkClientCloseParams, "talk.client.close", respond)) {
      return;
    }
    try {
      const config = context.getRuntimeConfig();
      // A Gateway-controlled session is already bound to this exact connection,
      // session key, and voice id. Let its owner close it before applying the raw
      // Matrix-key gate; the one-time binding used at create has been consumed.
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
      if (
        !isWebchatSessionAllowed({ cfg: config, client, sessionKey: params.sessionKey }) ||
        isUnauthorizedRawMatrixBrowserSession({
          cfg: config,
          clientInfo: client?.connect?.client,
          pairedClientId: client?.pairedClientId,
          sessionKey: params.sessionKey,
          authorizedByBinding: false,
        })
      ) {
        throw new Error("Matrix Talk sessions require an authorized binding");
      }
      const { agentId } =
        sessionMutationAuthorization?.talkSessionTarget ??
        prepareTalkSessionTarget(config, params.sessionKey);
      sessionMutationAuthorization?.assertCurrent();
      const origin = resolveClientVoiceSessionOrigin({
        agentId,
        sessionKey: params.sessionKey,
        voiceSessionId: params.voiceSessionId,
      });
      if (origin === "relay") {
        throw new Error("relay-owned voice sessions close through talk.session.close");
      }
      await closeClientVoiceSession({
        agentId,
        sessionKey: params.sessionKey,
        voiceSessionId: params.voiceSessionId,
        config,
      });
      const connId = normalizeOptionalString(client?.connId);
      if (connId) {
        unregisterTalkVoiceSession(params.voiceSessionId, connId, agentId);
        forgetLegacyVoiceBinding(connId, params.sessionKey, params.voiceSessionId);
      }
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
    }
  },
  "talk.client.steer": async ({
    params,
    respond,
    client,
    context,
    sessionMutationAuthorization,
  }) => {
    if (!assertValidParams(params, validateTalkClientSteerParams, "talk.client.steer", respond)) {
      return;
    }
    try {
      const target =
        sessionMutationAuthorization?.talkSessionTarget ??
        prepareTalkSessionTarget(context.getRuntimeConfig(), params.sessionKey);
      const runTarget = resolveOwnedActiveTalkRunTarget({
        context,
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
      const result = await controlRealtimeVoiceAgentRun({
        sessionKey: target.canonicalKey,
        runTarget,
        getToolAuthorityOverlay: () =>
          prepareTalkClientControlAuthority({
            config: context.getRuntimeConfig(),
            agentRuntime: createPluginRuntime().agent,
            sessionTarget: target,
            source: runTarget.toolAuthoritySource,
            authority: resolveTalkAgentConsultAuthority(client?.connect?.scopes, client),
          }),
        text: params.text,
        mode: params.mode,
      });
      respond(true, result, undefined);
    } catch (err) {
      if (err instanceof SessionMutationAuthorizationChangedError) {
        respond(false, undefined, err.error);
        return;
      }
      respond(
        false,
        undefined,
        errorShape(
          err instanceof AgentSelectionRequiredError
            ? ErrorCodes.INVALID_REQUEST
            : ErrorCodes.UNAVAILABLE,
          formatForLog(err),
        ),
      );
    }
  },
};
