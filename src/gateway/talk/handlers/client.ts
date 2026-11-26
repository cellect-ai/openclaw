import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateTalkClientToolCallParams,
  type ErrorShape,
} from "../../../../packages/gateway-protocol/src/index.js";
import {
  getCommandSenderAuthority,
  withCommandSenderAuthority,
} from "../../../auto-reply/command-sender-authority.js";
import {
  prepareSessionSourceAuthority,
  releaseSessionSourceAuthorities,
} from "../../../config/sessions/session-source-authority.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import {
  getRpcSourceForGateway,
  getRpcSourceIdentity,
  isRpcSourceRegistered,
} from "../../../sessions/session-controller.rpc-sources.js";
import { readOpenClawAgentDatabaseIdentity } from "../../../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseRuntime } from "../../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../../state/openclaw-agent-write-admission.js";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  buildRealtimeVoiceAgentConsultChatMessage,
  parseRealtimeVoiceAgentConsultArgs,
} from "../../../talk/agent-consult-tool.js";
import {
  authorizeClientVoiceConfirmation,
  authorizeCurrentClientVoiceConfirmation,
  bindAuthorizedClientVoiceConfirmation,
  type ClientVoiceConfirmationGrant,
} from "../../../talk/client-voice-confirmation.js";
import {
  assertClientVoiceSessionOpen,
  resolveOpenClientVoiceSessionId,
} from "../../../talk/client-voice-session-read.js";
import {
  captureClientVoiceSessionSourceOptions,
  createClientVoiceSessionSource,
  type ClientVoiceSessionSource,
} from "../../../talk/client-voice-session-source.js";
import { ensureClientVoiceAgentSessionEntry } from "../../../talk/client-voice-session-write.js";
import {
  createOrResumeClientVoiceSession,
  registerClientVoiceConsultRun,
} from "../../../talk/client-voice-session.js";
import { abortChatRunById } from "../../chat-abort.js";
import { transferGatewayLocalUserIngress } from "../../local-user-ingress.js";
import { authorizeGatewaySessionCreation } from "../../operator-role-policy.js";
import { transferGatewayOperatorSourceIdentity } from "../../operator-run-authority.js";
import { resolveSandboxedSessionCreation } from "../../operator-session-run.js";
import { handleTrustedInternalChatSend } from "../../server-methods/chat-send-handler.js";
import { gatewayClientSessionCreator } from "../../server-methods/gateway-client-identity.js";
import { readGatewayRequestMutationAuthority } from "../../server-methods/session-mutation-guards.js";
import type {
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "../../server-methods/types.js";
import { defineValidatedGatewayHandler } from "../../server-methods/validation.js";
import { prepareTalkRelayConsultAdmission } from "../../talk-relay-consult-admission.js";
import { isWebchatSessionAllowed } from "../../webchat-agent-authorization.js";
import { formatForLog } from "../../ws-log.js";
import { prepareTalkAgentConsultTranscript } from "../agent-consult-transcript.js";
import { resolveTalkAgentConsultAuthority } from "../client-tool-authority.js";
import {
  ensureTalkRealtimeRelayVoiceSession,
  flushTalkRealtimeRelayVoiceWrites,
  registerTalkRealtimeRelayAgentRun,
} from "../relay/operations.js";
import type { RelayAgentRunRegistration } from "../relay/state.js";
import { resolveOwnedTalkRealtimeRelaySession } from "../relay/state.js";
import { requirePreparedTalkSessionTarget } from "../session-target.js";
import { talkClientControlHandlers } from "./client-controls.js";
import { createTalkClient } from "./client-create.js";
import {
  readLegacyVoiceBinding,
  rememberLegacyVoiceBinding,
} from "./client-legacy-voice-bindings.js";
import { prepareTalkMatrixBrowserRefusal } from "./matrix-browser-talk-authorization.js";

function terminalTalkChatSendAckError(result: unknown): ErrorShape | undefined {
  const status = asNullableRecord(result)?.status;
  const message =
    status === "timeout"
      ? "Realtime agent consult ended before the run started."
      : status === "error"
        ? "Realtime agent consult failed before the run started."
        : status === "ok"
          ? "Realtime agent consult completed before the tool result subscription started."
          : undefined;
  return message ? errorShape(ErrorCodes.UNAVAILABLE, message) : undefined;
}

export const talkClientHandlers: GatewayRequestHandlers = {
  ...talkClientControlHandlers,

  "talk.client.create": createTalkClient,

  "talk.client.toolCall": defineValidatedGatewayHandler(
    "talk.client.toolCall",
    validateTalkClientToolCallParams,
    async (request) => {
      const { params, respond } = request;
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
        (await prepareTalkMatrixBrowserRefusal({
          cfg: config,
          client: request.client,
          sessionKey,
          agentId: target.agentId,
          authorizedByBinding: Boolean(
            connId &&
            relay?.matrixRoute &&
            relay.connId === connId &&
            relay.sessionTarget.canonicalKey === sessionKey,
          ),
        }))
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
      assertCommitAllowed();
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
      const voiceOptions = captureClientVoiceSessionSourceOptions(agentId);
      const prepareVoiceSession = async (assertStoreCurrent?: () => void) => {
        const requester = readGatewayRequestMutationAuthority(request);
        const preparedRequester = await prepareSessionSourceAuthority(requester.assertCurrent);
        const borrowedRequester = Object.assign(() => requester.assertCurrent(), {
          prepareSessionSource: async () => ({ ...preparedRequester, release: undefined }),
        });
        const errors: unknown[] = [];
        try {
          const assertPreparationCurrent = () => {
            assertStoreCurrent?.();
            requester.assertPreparationCurrent();
            if (preparedRequester.assertPreparedCurrent) {
              preparedRequester.assertPreparedCurrent();
            } else if (!preparedRequester.nativeSource) {
              preparedRequester.assertCurrent();
            }
          };
          // SDK callbacks may read SQLite; keep them outside the worker admission grants.
          if (preparedRequester.opaqueCommitGuard) {
            requester.assertCurrent();
          }
          const physicalSource = await withOpenClawAgentDatabaseRuntime(
            voiceOptions,
            (database) => {
              const identity = readOpenClawAgentDatabaseIdentity(database);
              if (typeof identity.identity !== "string") {
                throw new Error("Voice metadata requires its admitted persistent database");
              }
              return createClientVoiceSessionSource(voiceOptions, {
                key: `file:${identity.identity}`,
                canonicalPath: identity.canonicalPath,
                birthtime: identity.birthtime,
              });
            },
            assertPreparationCurrent,
            request.signal,
            (change) =>
              request.sessionMutationAuthorization?.followRegistration?.(
                { agentId, sessionKey: target.canonicalKey },
                change,
              ),
          );
          if (preparedRequester.opaqueCommitGuard) {
            requester.assertCurrent();
          }
          physicalSource.assertCurrent();
          assertStoreCurrent?.();
          request.sessionMutationAuthorization?.assertCurrent();
          // Shipped clients may consult without ever creating a voice session (old app,
          // restarted gateway, ambiguous open records). Implicitly create one instead of
          // erroring so voice identity and mutation evidence stay always-on.
          let selectedVoiceSessionId =
            explicitVoiceSessionId ??
            relaySessionId ??
            (connId ? readLegacyVoiceBinding(connId, sessionKey) : undefined);
          if (selectedVoiceSessionId === undefined) {
            const inferred = await resolveOpenClientVoiceSessionId(
              { agentId, sessionKey: sessionKey },
              physicalSource.options,
            );
            physicalSource.assertCurrent();
            // Another consult may have created and bound this connection during the read.
            selectedVoiceSessionId =
              (connId ? readLegacyVoiceBinding(connId, sessionKey) : undefined) ?? inferred;
          }
          if (!relaySessionId) {
            assertStoreCurrent?.();
            request.sessionMutationAuthorization?.assertCurrent();
          }
          const voiceSessionId =
            selectedVoiceSessionId ??
            (await createOrResumeClientVoiceSession({
              agentId,
              sessionKey: sessionKey,
              origin: "client",
              physicalSource,
              requester: borrowedRequester,
              source: {
                storePath: target.storePath,
                assertCurrent: request.sessionMutationAuthorization?.assertCurrent ?? (() => {}),
              },
              assertCurrent: () => {
                assertStoreCurrent?.();
                readGatewayRequestMutationAuthority(request).assertPreparationCurrent();
              },
            }));
          if (relaySessionId && connId) {
            await ensureClientVoiceAgentSessionEntry({
              agentId,
              sessionKey: target.canonicalKey,
              storePath: target.storePath,
              creation: resolveSandboxedSessionCreation(request.client, config),
              requester: borrowedRequester,
              source: request.sessionMutationAuthorization?.assertCurrent,
              prepareWorkerGrant: request.sessionMutationAuthorization?.prepareWorkerGrant,
              assertCurrent: () => {
                assertStoreCurrent?.();
                readGatewayRequestMutationAuthority(request).assertPreparationCurrent();
              },
              onCommittedSource: (readSource, entry) =>
                request.sessionMutationAuthorization?.recordCreatedSession?.({
                  agentId,
                  sessionKey: target.canonicalKey,
                  storePath: target.storePath,
                  sessionId: entry.sessionId,
                  entry,
                  lifecycleRevision: entry.lifecycleRevision,
                  readSource,
                }),
            });
            assertStoreCurrent?.();
            request.sessionMutationAuthorization?.assertCurrent();
            await ensureTalkRealtimeRelayVoiceSession({
              relaySessionId,
              connId,
              sessionKey: sessionKey,
            });
            await flushTalkRealtimeRelayVoiceWrites({ relaySessionId, connId });
          }
          assertStoreCurrent?.();
          request.sessionMutationAuthorization?.assertCurrent();
          const parsedArgs = parseRealtimeVoiceAgentConsultArgs(params.args ?? {});
          const origin = await assertClientVoiceSessionOpen(
            { agentId, sessionKey: sessionKey, voiceSessionId },
            physicalSource,
          );
          assertStoreCurrent?.();
          requester.assertCurrent();
          request.sessionMutationAuthorization?.assertCurrent();
          if (origin === "relay" && (!relaySessionId || !connId)) {
            throw new Error(
              "relay-owned voice sessions require relaySessionId and connection ownership",
            );
          }
          // Only validated calls may replace the legacy client's connection binding.
          if (connId && !relaySessionId) {
            physicalSource.assertCurrent();
            rememberLegacyVoiceBinding({ connId, sessionKey: sessionKey, voiceSessionId });
          }
          confirmationGrant = parsedArgs.confirmationId
            ? authorizeClientVoiceConfirmation({
                agentId,
                voiceSessionId,
                confirmationId: parsedArgs.confirmationId,
              })
            : authorizeCurrentClientVoiceConfirmation({ agentId, voiceSessionId });
          return { voiceSessionId, physicalSource };
        } catch (error) {
          errors.push(error);
          throw error;
        } finally {
          await releaseSessionSourceAuthorities([preparedRequester], errors);
        }
      };
      let preparedVoiceSession: Awaited<ReturnType<typeof prepareVoiceSession>>;
      try {
        // Legacy selection and publication share the writer FIFO; relay flushes cannot hold it.
        preparedVoiceSession = relaySessionId
          ? await prepareVoiceSession()
          : await runOpenClawAgentWriteAdmission(voiceOptions, (_identity, assertCurrent) =>
              prepareVoiceSession(assertCurrent),
            );
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
        return;
      }
      const { voiceSessionId } = preparedVoiceSession;

      const onRunStarted = async (
        runId: string,
        {
          assertWorkAdmissionCurrent,
          physicalSource,
          onRegistered,
        }: {
          assertWorkAdmissionCurrent: () => void;
          physicalSource?: ClientVoiceSessionSource;
          onRegistered?: (release: () => void) => void;
        },
      ): Promise<() => void> => {
        const release = await registerClientVoiceConsultRun({
          agentId,
          sessionKey: sessionKey,
          voiceSessionId,
          runId,
          config: request.context.getRuntimeConfig(),
          physicalSource: physicalSource ?? preparedVoiceSession.physicalSource,
          onRegistered,
          requester: readGatewayRequestMutationAuthority(request).assertCurrent,
          source: {
            storePath: target.storePath,
            assertCurrent: request.sessionMutationAuthorization?.assertCurrent ?? (() => {}),
            prepareWorkerGrant: request.sessionMutationAuthorization?.prepareWorkerGrant,
          },
          assertCurrent: () => {
            assertWorkAdmissionCurrent();
            readGatewayRequestMutationAuthority(request).assertPreparationCurrent();
          },
        });
        try {
          assertWorkAdmissionCurrent();
          request.sessionMutationAuthorization?.assertCurrent();
          if (confirmationGrant) {
            bindAuthorizedClientVoiceConfirmation({ grant: confirmationGrant, runId });
          }
          return release;
        } catch (error) {
          if (!onRegistered) {
            release();
          }
          throw error;
        }
      };
      const result = await (async (): Promise<
        { ok: true; runId: string; idempotencyKey: string } | { ok: false; error: ErrorShape }
      > => {
        let message: string;
        try {
          message = buildRealtimeVoiceAgentConsultChatMessage(params.args ?? {});
        } catch (err) {
          return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)) };
        }
        const normalizedTalk = request.context.getRuntimeConfig().talk;
        const authority = resolveTalkAgentConsultAuthority(
          request.client?.connect?.scopes,
          request.client,
        );
        // Only an explicitly requested voice ID scopes replay. An implicit record
        // may be regenerated after close/reconnect; chat still owns that call's replay.
        const idempotencyKey =
          "talk-" +
          sha256Hex(
            JSON.stringify([
              gatewayClientSessionCreator(request.client)?.id ??
                request.client?.authenticatedUserId,
              authority.replyCaller?.ApprovalReviewerDeviceId,
              target.agentId,
              target.canonicalKey,
              explicitVoiceSessionId ?? relaySessionId,
              params.callId,
            ]),
          );
        const unavailable = (errorMessage: string): { ok: false; error: ErrorShape } => ({
          ok: false,
          error: errorShape(ErrorCodes.UNAVAILABLE, errorMessage),
        });
        const matrixRoute = relay?.matrixRoute;
        const talkRelayAdmission =
          matrixRoute && relaySessionId && connId
            ? prepareTalkRelayConsultAdmission({
                relaySessionId,
                connId,
                sessionKey: target.canonicalKey,
                callId: params.callId,
                matrixRoute,
              })
            : undefined;
        let relayRegistration: RelayAgentRunRegistration | undefined;
        return await new Promise<
          { ok: true; runId: string; idempotencyKey: string } | { ok: false; error: ErrorShape }
        >((resolve) => {
          let acknowledged = false;
          const chatSendOptions = {
            ...request,
            client:
              request.client && authority.replyCaller
                ? withCommandSenderAuthority(
                    {
                      ...request.client,
                      connect: {
                        ...request.client.connect,
                        caps: authority.replyCaller.GatewayClientCaps,
                      },
                    },
                    getCommandSenderAuthority(authority.replyCaller),
                  )
                : request.client,
            req: {
              type: "req",
              id: `${request.req.id}:talk-tool-call`,
              method: "chat.send",
            },
            params: {
              sessionKey: target.canonicalKey,
              agentId: target.agentId,
              message,
              idempotencyKey,
              suppressCommandInterpretation: true,
              systemInputProvenance: {
                kind: "internal_system",
                sourceTool: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
              },
              ...(matrixRoute
                ? {
                    deliver: true,
                    originatingChannel: matrixRoute.channel,
                    originatingTo: `room:${matrixRoute.roomId}`,
                    originatingAccountId: matrixRoute.accountId,
                    originatingThreadId: matrixRoute.threadRootEventId,
                  }
                : {}),
              ...(normalizedTalk?.consultThinkingLevel
                ? { thinking: normalizedTalk.consultThinkingLevel }
                : {}),
              ...(typeof normalizedTalk?.consultFastMode === "boolean"
                ? { fastMode: normalizedTalk.consultFastMode }
                : {}),
            },
            respond: (ok: boolean, chatResult?: unknown, error?: ErrorShape) => {
              acknowledged = true;
              const ackError = ok
                ? terminalTalkChatSendAckError(chatResult)
                : (error ?? errorShape(ErrorCodes.UNAVAILABLE, "chat.send failed without error"));
              if (ackError) {
                resolve({ ok: false, error: ackError });
                return;
              }
              const candidateRunId = asNullableRecord(chatResult)?.runId;
              const runId = typeof candidateRunId === "string" ? candidateRunId : idempotencyKey;
              resolve(
                runId
                  ? { ok: true, runId, idempotencyKey }
                  : unavailable("chat.send did not acknowledge an active run"),
              );
            },
          } satisfies GatewayRequestHandlerOptions;
          if (request.client && chatSendOptions.client) {
            // Capability projection does not create a new authenticated principal.
            transferGatewayLocalUserIngress(request.client, chatSendOptions.client);
            transferGatewayOperatorSourceIdentity(request.client, chatSendOptions.client);
          }
          // Speech owns normal history; detached transports leave the accepted answer to Chat.
          const chatSendResult = handleTrustedInternalChatSend(chatSendOptions, undefined, {
            toolsAllow: authority.toolsAllow,
            talkRelayAdmission,
            ...(matrixRoute
              ? {
                  inboundEventKind: "user_request" as const,
                  sourceReplyDeliveryMode: "automatic" as const,
                }
              : {}),
            transcript: { display: false, excludeFromContext: true },
            prepareAssistantTranscriptMessage: (assistantMessage, sourceText) =>
              (relayRegistration?.prepareTranscript ?? prepareTalkAgentConsultTranscript)(
                assistantMessage,
                sourceText,
              ),
            beforeDispatch: async ({ runId, assertCurrent, assertWorkAdmissionCurrent }) => {
              let releaseClient: void | (() => void);
              const hasRelay = Boolean(relaySessionId && connId);
              const chat = getRpcSourceForGateway(
                runId,
                request.context.resolveGatewayContext,
                captureSessionTarget({
                  storeScope: target.storePath,
                  sessionKey: target.canonicalKey,
                  agentId: target.agentId,
                }),
              );
              const release = () => {
                releaseClient?.();
                relayRegistration?.release();
              };
              try {
                assertCurrent();
                if (relaySessionId && connId) {
                  if (!chat) {
                    throw new Error("Realtime relay agent run is not registered");
                  }
                  relayRegistration = await registerTalkRealtimeRelayAgentRun({
                    relaySessionId,
                    connId,
                    sessionKey: target.canonicalKey,
                    runId,
                    callId: params.callId,
                    transcriptSessionId: getRpcSourceIdentity(chat).sessionId,
                    assertCurrent: assertWorkAdmissionCurrent,
                    registerVoice: async (assertRelayCurrent, physicalSource, onRegistered) => {
                      await onRunStarted(runId, {
                        assertWorkAdmissionCurrent: assertRelayCurrent,
                        physicalSource,
                        onRegistered,
                      });
                    },
                  });
                } else {
                  releaseClient = await onRunStarted(runId, { assertWorkAdmissionCurrent });
                }
                assertCurrent();
                if (relayRegistration && !relayRegistration.isCurrent()) {
                  throw new Error("Realtime relay run registration changed while waiting");
                }
                return release;
              } catch (error) {
                relayRegistration?.abortIfCurrent();
                if (!hasRelay && chat && isRpcSourceRegistered(chat)) {
                  abortChatRunById(request.context, {
                    runId,
                    sessionKey: target.canonicalKey,
                    expectedEntry: chat,
                    stopReason: "voice session binding failed",
                  });
                }
                release();
                throw error;
              }
            },
          });
          void Promise.resolve(chatSendResult).then(
            () => {
              if (!acknowledged) {
                resolve(unavailable("chat.send did not return a realtime tool result"));
              }
            },
            (error: unknown) => {
              if (acknowledged) {
                request.context.logGateway.warn(
                  `realtime Talk agent consult failed after acknowledgement: ${formatForLog(error)}`,
                );
                return;
              }
              resolve(unavailable(formatForLog(error)));
            },
          );
        });
      })();
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
  ),
};
