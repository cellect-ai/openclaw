import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateTalkSessionCreateParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import { composeSessionSourceAssertion } from "../../../config/sessions/session-source-authority.js";
import { assertSecretOwnerAvailable } from "../../../secrets/runtime-degraded-state.js";
import { operatorScopeSatisfied } from "../../../shared/operator-scope-compat.js";
import { resolveSessionMethodScope } from "../../../shared/session-method-scopes-base.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL } from "../../../talk/agent-consult-tool.js";
import { REALTIME_VOICE_AGENT_CONTROL_TOOL } from "../../../talk/agent-run-control-shared.js";
import { ensureClientVoiceAgentSessionEntry } from "../../../talk/client-voice-session-write.js";
import {
  projectInternalRealtimeVoicePublicConfig,
  resolveInternalRealtimeVoiceGatewayRelayLaunchError,
} from "../../../talk/provider-internal.js";
import { resolveConfiguredRealtimeVoiceProviderAsync } from "../../../talk/provider-resolver.js";
import { ADMIN_SCOPE, hasGatewayAdminScope } from "../../operator-scopes.js";
import { resolveSandboxedSessionCreation } from "../../operator-session-run.js";
import { readGatewayRequestMutationAuthority } from "../../server-methods/session-mutation-guards.js";
import type { GatewayRequestHandlers } from "../../server-methods/types.js";
import { defineValidatedGatewayHandler } from "../../server-methods/validation.js";
import { resolveOperatorSessionCreation } from "../../session-creation-provenance.js";
import { getSessionRowProjection } from "../../session-row-projection-access.js";
import { withPreparedSessionResolve } from "../../sessions-resolve.js";
import { consumeTalkBindingCapability } from "../../talk-binding-capability.js";
import { isWebchatSessionAllowed } from "../../webchat-agent-authorization.js";
import { retainTalkClientRunAuthority } from "../client-run-authority.js";
import { resolveTalkAgentConsultAuthority } from "../client-tool-authority.js";
import { createTalkHandoff } from "../handoff.js";
import { createTalkRealtimeRelaySession } from "../relay/session-create.js";
import {
  buildRealtimeInstructions,
  buildRealtimeVoiceLaunchOptions,
  buildTalkRealtimeConfig,
  buildTalkTranscriptionConfig,
  resolveConfiguredRealtimeTranscriptionProvider,
  resolveTalkRealtimeProviderInstructions,
} from "../session-config.js";
import {
  buildTalkRealtimeHistoryInstructions,
  readTalkRealtimeInitialItems,
} from "../session-history.js";
import { rememberUnifiedTalkSession } from "../session-registry.js";
import { restoreTalkSessionTarget } from "../session-start.js";
import { prepareTalkSessionTarget, requirePreparedTalkSessionTarget } from "../session-target.js";
import { createTalkTranscriptionRelaySession } from "../transcription-relay.js";
import { prepareTalkVoiceReplacement } from "../voice-selection.js";
import { prepareTalkMatrixBrowserRefusal } from "./matrix-browser-talk-authorization.js";
import { talkSessionControlHandlers } from "./session-controls.js";
import { respondInvalidRequest, respondOk, talkSessionError } from "./session-responses.js";

export const talkSessionHandlers: GatewayRequestHandlers = {
  ...talkSessionControlHandlers,

  "talk.session.create": defineValidatedGatewayHandler(
    "talk.session.create",
    validateTalkSessionCreateParams,
    async (request) => {
      const {
        params,
        respond,
        context,
        client,
        sessionMutationAuthorization,
        sessionMutationCommitGuard,
        hasCurrentClientAuthority,
      } = request;
      const requester = readGatewayRequestMutationAuthority(request);
      const mode = params.mode ?? (params.transport === "managed-room" ? "stt-tts" : "realtime");
      const transport = params.transport ?? (mode === "stt-tts" ? "managed-room" : "gateway-relay");
      const brain = params.brain ?? (mode === "transcription" ? "none" : "agent-consult");
      if (
        !operatorScopeSatisfied("operator.talk", client?.connect.scopes ?? []) &&
        resolveSessionMethodScope("talk.session.create", params) !== "operator.sessions.write"
      ) {
        respondInvalidRequest(
          respond,
          "Session dictation requires a session target and configured transcription",
        );
        return;
      }

      if (transport === "webrtc" || transport === "provider-websocket") {
        respondInvalidRequest(
          respond,
          `talk.session.create is Gateway-managed; use talk.client.create for client transport "${transport}"`,
        );
        return;
      }
      sessionMutationAuthorization?.assertCurrent();
      if (params.voiceChangeId && (mode !== "realtime" || transport !== "gateway-relay")) {
        respondInvalidRequest(respond, "A voice replacement requires a realtime relay session");
        return;
      }
      if (transport === "managed-room") {
        if (brain === "direct-tools" && !hasGatewayAdminScope(client)) {
          respondInvalidRequest(
            respond,
            `talk.session.create brain="direct-tools" requires gateway scope: ${ADMIN_SCOPE}`,
          );
          return;
        }
        const spawnedBy = normalizeOptionalString(params.spawnedBy);
        const requestedSessionKey = normalizeOptionalString(params.sessionKey);
        if (requestedSessionKey && !spawnedBy && !hasGatewayAdminScope(client)) {
          respondInvalidRequest(
            respond,
            `talk.session.create managed-room sessionKey requires spawnedBy or gateway scope: ${ADMIN_SCOPE}`,
          );
          return;
        }
        const target = requestedSessionKey
          ? requirePreparedTalkSessionTarget(sessionMutationAuthorization?.talkSessionTarget)
          : undefined;
        sessionMutationAuthorization?.assertCurrent();
        const projection = getSessionRowProjection(context);
        if (!projection) {
          respondInvalidRequest(respond, "Session rows are initializing; try again");
          return;
        }
        return await withPreparedSessionResolve(
          {
            projection,
            client,
            isCurrent: () => getSessionRowProjection(context) === projection,
            p: {
              key: target?.canonicalKey,
              ...(target ? { agentId: target.agentId } : {}),
              ...(spawnedBy ? { spawnedBy } : {}),
              includeGlobal: true,
              includeUnknown: true,
            },
          },
          (resolvedSession) => {
            if (!resolvedSession.ok) {
              respond(false, undefined, resolvedSession.error);
              return;
            }
            if ("missing" in resolvedSession || "ambiguous" in resolvedSession) {
              respondInvalidRequest(respond, `No session found: ${params.sessionKey}`);
              return;
            }
            sessionMutationCommitGuard?.();
            sessionMutationAuthorization?.assertCurrent();
            const handoff = createTalkHandoff({
              sessionKey: resolvedSession.key,
              provider: normalizeOptionalString(params.provider),
              model: normalizeOptionalString(params.model),
              voice: normalizeOptionalString(params.voice),
              mode,
              transport,
              brain,
              ttlMs: params.ttlMs,
            });
            rememberUnifiedTalkSession(handoff.id, {
              kind: "managed-room",
              handoffId: handoff.id,
              roomId: handoff.roomId,
            });
            return respondOk(respond, {
              sessionId: handoff.id,
              provider: handoff.provider,
              mode: handoff.mode,
              transport: handoff.transport,
              brain: handoff.brain,
              handoffId: handoff.id,
              roomId: handoff.roomId,
              roomUrl: handoff.roomUrl,
              token: handoff.token,
              model: handoff.model,
              voice: handoff.voice,
              expiresAt: handoff.expiresAt,
            });
          },
        );
      }

      const connId = client?.connId;
      if (!connId) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Talk session unavailable"));
        return;
      }

      if (mode === "realtime") {
        if (transport !== "gateway-relay" || brain !== "agent-consult") {
          return respondInvalidRequest(
            respond,
            `realtime talk.session.create requires transport="gateway-relay" and brain="agent-consult"`,
          );
        }
        const replacement = prepareTalkVoiceReplacement({
          voiceChangeId: params.voiceChangeId,
          connId,
          sessionKey: params.sessionKey,
        });
        const requested = replacement ? { ...params, ...replacement.launch } : params;
        const runtimeConfig = context.getRuntimeConfig();
        const binding = normalizeOptionalString(params.binding);
        if (binding && normalizeOptionalString(params.sessionKey)) {
          return respondInvalidRequest(
            respond,
            "Talk binding and sessionKey are mutually exclusive",
          );
        }
        const bound = binding ? consumeTalkBindingCapability(binding) : undefined;
        if (binding && !bound) {
          return respondInvalidRequest(respond, "Talk binding is invalid or expired");
        }
        const realtimeConfig = await buildTalkRealtimeConfig(
          runtimeConfig,
          requested.provider,
          requested.model,
        );
        const launchOptions = buildRealtimeVoiceLaunchOptions({
          requested,
          defaults: realtimeConfig,
        });
        const target = requirePreparedTalkSessionTarget(
          sessionMutationAuthorization?.talkSessionTarget,
        );
        if (
          bound &&
          (bound.agentId !== target.agentId ||
            (bound.sessionKey !== target.sessionKey && bound.sessionKey !== target.canonicalKey))
        ) {
          return respondInvalidRequest(
            respond,
            "Talk binding does not match the authorized session target",
          );
        }
        replacement?.assertCurrent(target);
        const { agentId } = target;
        const assertCommitAllowed = composeSessionSourceAssertion(
          [sessionMutationCommitGuard, sessionMutationAuthorization?.assertCurrent],
          (assertSources) => {
            assertSources();
            replacement?.assertCurrent(target);
          },
        );
        assertCommitAllowed();
        if (
          (await prepareTalkMatrixBrowserRefusal({
            cfg: runtimeConfig,
            client,
            sessionKey: target.canonicalKey,
            agentId: target.agentId,
            authorizedByBinding: Boolean(bound),
          })) ||
          !isWebchatSessionAllowed({ cfg: runtimeConfig, client, sessionKey: target.canonicalKey })
        ) {
          return respondInvalidRequest(
            respond,
            "Matrix Talk sessions require an authorized binding",
          );
        }
        assertCommitAllowed();
        assertSecretOwnerAvailable("capability", "talk:realtime");
        const resolution = await resolveConfiguredRealtimeVoiceProviderAsync({
          configuredProviderId: realtimeConfig.provider,
          providerConfigs: realtimeConfig.providers,
          providerConfigOverrides: launchOptions.model ? { model: launchOptions.model } : {},
          cfg: runtimeConfig,
          agentId,
          defaultModel: realtimeConfig.model,
          surface: "gateway-relay",
          autoRespondToAudio: realtimeConfig.consultRouting !== "force-agent-consult",
        });
        const forceAgentConsultOnFinalTranscript =
          realtimeConfig.consultRouting === "force-agent-consult";
        const { model: _model, ...overrides } = launchOptions;
        const providerConfig =
          Object.keys(overrides).length > 0
            ? { ...resolution.providerConfig, ...overrides }
            : resolution.providerConfig;
        const launchError = resolveInternalRealtimeVoiceGatewayRelayLaunchError({
          provider: resolution.provider,
          cfg: runtimeConfig,
          providerConfig,
          model: launchOptions.model,
          autoRespondToAudio: !forceAgentConsultOnFinalTranscript,
        });
        if (launchError) {
          // GPT-Live delegates natively; forced transcript consults are a GA-model mode.
          return respondInvalidRequest(respond, launchError);
        }
        const capabilities = resolution.capabilities;
        const controlSource =
          capabilities?.handlesAgentConsult === true ? "delegation" : "transcript";
        // Profile files do not depend on the session row. Read them while that
        // row is ensured. History names the row, so it starts only after.
        const instructionsPromise = resolveTalkRealtimeProviderInstructions({
          config: runtimeConfig,
          agentId,
          configuredInstructions: realtimeConfig.instructions,
          sessionKey: target.canonicalKey,
          warn: (message) => context.logGateway.warn(`talk realtime context: ${message}`),
        });
        // A failure before the join below must not leave this read unhandled; the
        // join still awaits and rethrows it.
        instructionsPromise.catch(() => undefined);
        assertCommitAllowed();
        await restoreTalkSessionTarget(request, target, replacement?.source(target).assertCurrent);
        const ensuredSessionId = await ensureClientVoiceAgentSessionEntry({
          agentId,
          sessionKey: target.canonicalKey,
          storePath: target.storePath,
          creation:
            resolveSandboxedSessionCreation(client, runtimeConfig) ??
            resolveOperatorSessionCreation(client),
          requester: composeSessionSourceAssertion([
            requester.assertCurrent,
            replacement?.source(target).assertCurrent,
          ]),
          source: sessionMutationAuthorization?.assertCurrent,
          prepareWorkerGrant: sessionMutationAuthorization?.prepareWorkerGrant,
          followRegistration: (change) =>
            sessionMutationAuthorization?.followRegistration?.(
              { agentId, sessionKey: target.canonicalKey },
              change,
            ),
          assertCurrent: requester.assertPreparationCurrent,
          onCommittedSource: (readSource, entry) =>
            sessionMutationAuthorization?.recordCreatedSession?.({
              agentId,
              sessionKey: target.canonicalKey,
              storePath: target.storePath,
              sessionId: entry.sessionId,
              entry,
              lifecycleRevision: entry.lifecycleRevision,
              readSource,
            }),
        });
        const assertEnsuredTargetCurrent = () => {
          sessionMutationCommitGuard?.();
          sessionMutationAuthorization?.assertTargetCurrent({
            agentId,
            sessionKey: target.canonicalKey,
            ensuredSessionId,
          });
          replacement?.assertCurrent(target);
        };
        const [providerInstructions, initialItems] = await Promise.all([
          instructionsPromise,
          readTalkRealtimeInitialItems(target, assertEnsuredTargetCurrent),
        ]);
        assertEnsuredTargetCurrent();
        const model =
          normalizeOptionalString(providerConfig.model) ?? resolution.provider.defaultModel;
        const voices = [
          ...(capabilities?.voices ??
            (model ? capabilities?.voicesByModel?.[model] : undefined) ??
            resolution.provider.voices ??
            []),
        ];
        const session = await retainTalkClientRunAuthority({
          client,
          context,
          hasCurrentClientAuthority,
        }).then((runAuthority) => {
          try {
            assertEnsuredTargetCurrent();
            runAuthority.accept();
            return createTalkRealtimeRelaySession({
              runAuthority,
              context,
              connId,
              cfg: runtimeConfig,
              consultAuthority: resolveTalkAgentConsultAuthority(client?.connect?.scopes, client),
              provider: resolution.provider,
              providerConfig,
              controlSource,
              capabilities,
              clientCapabilities: params.capabilities,
              voiceChangeId: params.voiceChangeId,
              initialItems,
              voiceSelectionVoices: voices,
              instructions:
                buildRealtimeInstructions(providerInstructions, params.sessionCapsule, {
                  providerHandlesAgentConsult: controlSource === "delegation",
                }) + buildTalkRealtimeHistoryInstructions(initialItems),
              tools:
                controlSource === "delegation"
                  ? []
                  : [REALTIME_VOICE_AGENT_CONSULT_TOOL, REALTIME_VOICE_AGENT_CONTROL_TOOL],
              model: launchOptions.model,
              sessionTarget: target,
              voice: launchOptions.voice,
              language: params.language ?? "en",
              transcriptionHints: params.transcriptionHints,
              sessionCapsule: params.sessionCapsule,
              speakerMxid: bound?.speakerMxid,
              matrixRoute: bound
                ? {
                    channel: "matrix",
                    roomId: bound.roomId,
                    threadRootEventId: bound.threadRootEventId,
                    accountId: bound.accountId,
                  }
                : undefined,
              forceAgentConsultOnFinalTranscript,
            });
          } catch (error) {
            runAuthority.release();
            throw error;
          }
        });
        rememberUnifiedTalkSession(session.relaySessionId, {
          kind: "realtime-relay",
          connId,
          relaySessionId: session.relaySessionId,
          sessionTarget: target,
        });
        const publicSession = projectInternalRealtimeVoicePublicConfig({
          provider: resolution.provider,
          providerConfig,
          config: session,
        });
        return respondOk(respond, {
          ...publicSession,
          sessionId: session.relaySessionId,
          voiceSessionId: session.relaySessionId,
          mode,
          brain,
        });
      }

      if (mode === "transcription") {
        if (transport !== "gateway-relay" || brain !== "none") {
          respondInvalidRequest(
            respond,
            `transcription talk.session.create requires transport="gateway-relay" and brain="none"`,
          );
          return;
        }
        const runtimeConfig = context.getRuntimeConfig();
        const sessionKey = normalizeOptionalString(params.sessionKey);
        const target =
          sessionMutationAuthorization?.talkSessionTarget ??
          (sessionKey && hasGatewayAdminScope(client)
            ? await prepareTalkSessionTarget(runtimeConfig, sessionKey)
            : undefined);
        if (sessionKey) {
          requirePreparedTalkSessionTarget(target);
        }
        const assertCurrent = () => {
          requester.assertCurrent();
          // Retain the admitted session authority, not only its routing facts:
          // provider callbacks can arrive after deletion, replacement, or revocation.
          sessionMutationAuthorization?.assertCurrent();
          if (target) {
            target.assertCurrent(context.getRuntimeConfig());
          }
        };
        const transcriptionConfig = await buildTalkTranscriptionConfig(
          runtimeConfig,
          params.provider,
          params.model,
          target?.agentId,
        );
        if (transcriptionConfig.file && !transcriptionConfig.file.ready) {
          throw new Error(
            "No configured audio transcription provider is available; check tools.media.models",
          );
        }
        const resolution = transcriptionConfig.file
          ? { file: transcriptionConfig.file }
          : await resolveConfiguredRealtimeTranscriptionProvider({
              config: runtimeConfig,
              configuredProviderId: transcriptionConfig.provider,
              providerConfigs: transcriptionConfig.providers,
              requestedModel: normalizeOptionalString(params.model),
              defaultModel: transcriptionConfig.model,
            });
        assertCurrent();
        const releaseAuthority = sessionMutationAuthorization?.retain?.();
        let session: ReturnType<typeof createTalkTranscriptionRelaySession>;
        try {
          session = createTalkTranscriptionRelaySession({
            context,
            connId,
            assertCurrent,
            releaseAuthority,
            ...(target ? { sessionKey: target.canonicalKey } : {}),
            ...resolution,
          });
        } catch (error) {
          releaseAuthority?.();
          throw error;
        }
        rememberUnifiedTalkSession(session.transcriptionSessionId, {
          kind: "transcription-relay",
          connId,
          transcriptionSessionId: session.transcriptionSessionId,
          ...(target ? { sessionTarget: target } : {}),
        });
        respondOk(respond, {
          ...session,
          sessionId: session.transcriptionSessionId,
          brain,
        });
        return;
      }

      respondInvalidRequest(
        respond,
        `stt-tts talk.session.create requires transport="managed-room"`,
      );
    },
    talkSessionError,
  ),
};
