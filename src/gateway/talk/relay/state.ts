import { randomUUID } from "node:crypto";
import type { TalkClientCreateResult } from "../../../../packages/gateway-protocol/src/schema/channels.js";
import type { PrepareAssistantTranscriptMessage } from "../../../config/sessions/transcript-assistant-delivery.js";
import type { OpenClawConfig } from "../../../config/types.js";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import type { GatewayRootWorkAdmissionContinuationScope } from "../../../process/gateway-work-admission.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import { getRpcSourceForGateway } from "../../../sessions/session-controller.rpc-sources.js";
import type { BoundedSerialQueue } from "../../../shared/bounded-serial-queue.js";
import type { RealtimeVoiceAgentControlResult } from "../../../talk/agent-run-control.js";
import type {
  ClientVoiceSessionSource,
  ClientVoiceSessionWriter,
} from "../../../talk/client-voice-session-source.js";
import type { createClientVoiceTranscriptReadiness } from "../../../talk/client-voice-transcript-readiness.js";
import type { InternalRealtimeVoiceProviderCapabilities } from "../../../talk/provider-internal.js";
import type {
  RealtimeVoiceAudioClearReason,
  RealtimeVoiceBrowserAudioContract,
  RealtimeVoiceCloseDisposition,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceTool,
  RealtimeVoiceToolResultOptions,
} from "../../../talk/provider-types.js";
import type { RealtimeVoiceSessionHarness } from "../../../talk/realtime-session-harness.js";
import type { RealtimeVoiceBridgeSession } from "../../../talk/session-runtime.js";
import type { TalkEvent, TalkEventInput } from "../../../talk/talk-session-controller.js";
import { abortChatRunById } from "../../chat-abort.js";
import type { GatewayRequestContext } from "../../server-methods/shared-types.js";
import type { TalkClientRunAuthority } from "../client-run-authority.js";
import type { TalkAgentConsultAuthority } from "../client-tool-authority.js";
import type { PreparedTalkSessionTarget } from "../session-target.types.js";
import {
  noFallbackRelayOutputFlush,
  TalkRealtimeRelayOutputOwnership,
} from "./output-ownership.js";
import type { RelayToolCallLedger } from "./tool-call-ledger.js";
export {
  noFallbackRelayOutputFlush,
  TalkRealtimeRelayOutputOwnership,
} from "./output-ownership.js";

export const RELAY_SESSION_TTL_MS = 30 * 60 * 1000;
export const MAX_AUDIO_BASE64_BYTES = 512 * 1024;
const RELAY_EVENT = "talk.event";
export const RELAY_TRANSCRIPT_ECHO_LOOKBACK_MS = 12_000;

type TalkRealtimeRelayEventData =
  | { type: "ready" }
  | { type: "responseStarted"; turnId: string }
  | { type: "inputAudio"; byteLength: number }
  | { type: "inputAudioStart"; itemId: string }
  | {
      type: "audio";
      audioBase64: string;
      itemId?: string;
      responseId?: string;
    }
  | { type: "audioDone"; itemId?: string; responseId?: string }
  | { type: "clear"; reason?: RealtimeVoiceAudioClearReason }
  | { type: "mark"; markName: string }
  | {
      type: "transcript";
      role: "user" | "assistant";
      text: string;
      final: boolean;
      itemId?: string;
      textMode?: "delta" | "snapshot";
      transcriptId?: string;
    }
  | {
      type: "toolCall";
      itemId: string;
      callId: string;
      name: string;
      args: unknown;
      forced?: boolean;
    }
  | { type: "toolCallCancelled"; callId: string }
  | { type: "toolResult"; callId: string }
  | { type: "toolProgress"; result: RealtimeVoiceAgentControlResult }
  | {
      type: "error";
      message: string;
      code?: "realtime_unavailable";
      provider?: string;
      model?: string;
      transport?: "gateway-relay";
      phase?: string;
    }
  | { type: "close"; reason: "completed" | "error" };

export type TalkRealtimeRelayEventPayload = TalkRealtimeRelayEventData & { relaySessionId: string };

type TalkRealtimeRelayEvent = TalkRealtimeRelayEventData & { talkEvent?: TalkEvent };

export type ForcedTerminalProviderResult = {
  result: unknown;
  options?: RealtimeVoiceToolResultOptions;
  turnId: string;
  epoch: number;
  nativeCallIds?: readonly string[];
};

export type RelayAgentControlProviderSubmission = {
  completion?: Promise<void>;
  providerResponseStarted: boolean;
};

export type RelayAgentRun = {
  runId: string;
  sessionKey: string;
  detached?: boolean;
  standalone?: RelayAgentRunRegistration;
  releaseVoice?: () => void;
};

export type RelayAgentRunRegistration = {
  run: RelayAgentRun;
  isCurrent: (phase?: "active" | "completion") => boolean;
  release: () => void;
  abortIfCurrent: () => void;
  prepareTranscript: PrepareAssistantTranscriptMessage;
};

export type RelaySession = {
  /** Teardown custody is separate from live call/presentation authority. */
  cleanupAdmission?: GatewayRootWorkAdmissionContinuationScope;
  getToolAuthorityOverlay?: (
    authority?: TalkAgentConsultAuthority,
    source?: "reply" | "attempt",
  ) => Promise<
    import("../../../sessions/session-controller.contracts.js").ReplyToolAuthorityOverlay
  >;
  id: string;
  connId: string;
  context: GatewayRequestContext;
  bridge: RealtimeVoiceBridgeSession;
  harness: RealtimeVoiceSessionHarness;
  capabilities?: InternalRealtimeVoiceProviderCapabilities;
  outputOwnership: TalkRealtimeRelayOutputOwnership;
  sessionTarget: PreparedTalkSessionTarget;
  speakerMxid?: string;
  closeDisposition?: RealtimeVoiceCloseDisposition;
  matrixRoute?: { channel: "matrix"; roomId: string; threadRootEventId: string; accountId: string };
  expiresAtMs: number;
  cleanupTimer: ReturnType<typeof setTimeout>;
  activeAgentRuns: Map<string, RelayAgentRun>;
  /** Keep completed consult answers until the transport can no longer speak them. */
  unspokenAnswers?: Map<string, (writer: ClientVoiceSessionWriter) => Promise<void>>;
  provider: string;
  activeAgentToolCalls: Map<string, RelayAgentRunRegistration>;
  agentToolCallTerminalSubscriptions?: Map<string, () => void>;
  toolCalls: RelayToolCallLedger;
  providerToolCallIds: Map<string, string>;
  relayToolCallIdsByProviderId: Map<string, string>;
  pendingFinalToolResults: Map<string, Promise<void>>;
  pendingProviderToolResults: Map<string, Promise<void>>;
  // A final result must wait until the provider accepts its continuation result;
  // otherwise async bridges can observe final-before-working ordering.
  pendingWorkingToolResults: Map<string, Promise<void>>;
  // Keep a forced terminal result open while late matching native ids join it.
  // Delivery/cancellation closes the state only after every current id accepts.
  forcedTerminalProviderResults: Map<string, ForcedTerminalProviderResult>;
  // Turn cancellation invalidates async acceptance callbacks from the prior turn.
  toolResultEpoch: number;
  voiceConfig?: OpenClawConfig;
  voiceSessionSource?: ClientVoiceSessionSource;
  voiceSessionCreated: boolean;
  voiceSessionCreation?: Promise<boolean>;
  voiceTranscriptSeq: number;
  voiceTranscriptQueue: BoundedSerialQueue;
  runAuthority?: TalkClientRunAuthority;
  transcriptReadiness: ReturnType<typeof createClientVoiceTranscriptReadiness>;
  voiceSessionClose?: Promise<void>;
  voiceUtterance?: {
    role: "user" | "assistant";
    key: string;
    text: string;
    eventId?: string;
    /** When this line's final arrived; a revision must follow within a short window. */
    at: number;
  };
  closing?: {
    reason: "completed" | "error";
    completion?: Promise<void>;
    runTranscript?: (run: () => boolean) => boolean;
  };
  failSession: (message: string) => void;
};

export type CreateTalkRealtimeRelaySessionParams = {
  context: GatewayRequestContext;
  connId: string;
  cfg?: OpenClawConfig;
  consultAuthority?: TalkAgentConsultAuthority;
  runAuthority?: TalkClientRunAuthority;
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
  controlSource: "delegation" | "transcript";
  capabilities?: InternalRealtimeVoiceProviderCapabilities;
  clientCapabilities?: readonly "voice-selection"[];
  voiceChangeId?: string;
  voiceSelectionVoices?: readonly string[];
  initialItems?: Array<{ role: "user" | "assistant"; text: string }>;
  instructions: string;
  tools: RealtimeVoiceTool[];
  model?: string;
  sessionTarget: PreparedTalkSessionTarget;
  voice?: string;
  language?: string;
  transcriptionHints?: { prompt?: string; keywords?: string[] };
  sessionCapsule?: string;
  forceAgentConsultOnFinalTranscript?: boolean;
  speakerMxid?: string;
  matrixRoute?: { channel: "matrix"; roomId: string; threadRootEventId: string; accountId: string };
};

export type TalkRealtimeRelaySessionResult = Omit<
  Extract<TalkClientCreateResult, { transport: "gateway-relay" }>,
  "voiceSessionId" | "audio"
> & {
  audio: RealtimeVoiceBrowserAudioContract;
  expiresAt: number;
};

export const relaySessions = new Map<string, RelaySession>();
// Closing relays reject new work but retain bounded final transcripts until
// provider finalization and durable close settle. Session limits count both sets.

/** Resolve browser capabilities only against their live connection-owned relay. */
export function resolveOwnedTalkRealtimeRelaySession(
  relaySessionId: string,
  connId: string | undefined,
): RelaySession | undefined {
  const relay = relaySessions.get(relaySessionId);
  return connId && relay?.connId === connId && relay.expiresAtMs >= Date.now() ? relay : undefined;
}
export const drainingRelaySessions = new Set<RelaySession>();

export function adoptRelayProviderToolCallId(
  session: RelaySession,
  providerCallId: string,
): string | undefined {
  if (session.toolCalls.isProviderCompleted(providerCallId)) {
    return undefined;
  }
  const current = session.relayToolCallIdsByProviderId.get(providerCallId);
  if (current) {
    return session.toolCalls.isAgentCompleted(current) ? undefined : current;
  }
  const relayCallId = session.toolCalls.isAgentCompleted(providerCallId)
    ? `relay-${randomUUID()}`
    : providerCallId;
  // Realtime protocols define no replay window. Retain every admitted identity
  // for the session and fail closed at the hard cap instead of evicting dedupe state.
  if (!session.toolCalls.tryAdmit([providerCallId, relayCallId])) {
    return undefined;
  }
  session.toolCalls.deleteAgentCompleted(relayCallId);
  session.providerToolCallIds.set(relayCallId, providerCallId);
  session.relayToolCallIdsByProviderId.set(providerCallId, relayCallId);
  return relayCallId;
}

export function resolveRelayProviderToolCallId(session: RelaySession, relayCallId: string): string {
  return session.providerToolCallIds.get(relayCallId) ?? relayCallId;
}

export function broadcastToOwner(
  session: Pick<RelaySession, "id" | "context" | "connId" | "harness">,
  event: TalkRealtimeRelayEvent,
  talkEvent?: TalkEventInput,
): void {
  const payload = {
    relaySessionId: session.id,
    ...event,
    ...(talkEvent ? { talkEvent: session.harness.talk.emit(talkEvent) } : {}),
  };
  // Classify the materialized Talk event so final results cannot be mistaken
  // for transient tool progress by individual provider callback paths.
  const dropIfSlow =
    event.type === "audio" ||
    event.type === "inputAudio" ||
    (event.type === "transcript" && !event.final) ||
    ((event.type === "toolProgress" || event.type === "toolResult") &&
      payload.talkEvent?.final !== true);
  session.context.broadcastToConnIds(RELAY_EVENT, payload, new Set([session.connId]), {
    dropIfSlow,
  });
}

export function broadcastRelaySessionClosed(
  session: RelaySession,
  reason: "completed" | "error",
  eventReason?: "output-cancelled",
): void {
  broadcastToOwner(
    session,
    { type: "close", reason },
    {
      type: "session.closed",
      payload: { reason: reason === "error" ? "error" : (eventReason ?? reason) },
      final: true,
    },
  );
}

export function cancelRelayTurn(session: RelaySession, turnId: string, reason: string): void {
  const cancelled = session.harness.talk.cancelTurn({ turnId, payload: { reason } });
  broadcastToOwner(session, {
    type: "clear",
    talkEvent: cancelled.ok ? cancelled.event : undefined,
  });
}

export function ensureRelayTurn(session: RelaySession): string {
  const turn = session.harness.talk.ensureTurn();
  if (turn.event) {
    broadcastToOwner(session, { type: "inputAudio", byteLength: 0, talkEvent: turn.event });
  }
  return turn.turnId;
}

/** The two existing indexes own one run with independent provider-call registrations. */
export function hasRelayAgentRunRegistrations(
  session: RelaySession,
  run: RelayAgentRun,
  except?: RelayAgentRunRegistration,
): boolean {
  return (
    Boolean(run.standalone && run.standalone !== except) ||
    [...session.activeAgentToolCalls.values()].some(
      (registration) => registration.run === run && registration !== except,
    )
  );
}

export function pruneInactiveRelayAgentRuns(session: RelaySession): number {
  const target = captureSessionTarget({
    storeScope: session.sessionTarget.storePath,
    sessionKey: session.sessionTarget.canonicalKey,
    agentId: session.sessionTarget.agentId,
  });
  let active = 0;
  for (const [runId, run] of session.activeAgentRuns) {
    if (!getRpcSourceForGateway(runId, session.context.resolveGatewayContext, target)) {
      // Final delivery can outlive the controller turn, but cannot control another turn.
      const completionCurrent =
        run.standalone?.isCurrent("completion") ||
        [...session.activeAgentToolCalls.values()].some(
          (registration) => registration.run === run && registration.isCurrent("completion"),
        );
      if (completionCurrent) {
        continue;
      }
      session.activeAgentRuns.delete(runId);
      run.releaseVoice?.();
    } else {
      active += 1;
    }
  }
  for (const [callId, { run }] of session.activeAgentToolCalls) {
    if (session.activeAgentRuns.get(run.runId) !== run) {
      session.activeAgentToolCalls.delete(callId);
    }
  }
  return active;
}

/** Omitting the abort reason releases relay correlation while accepted work continues. */
export function retireRelayAgentRuns(session: RelaySession, reason?: string): void {
  if (reason === undefined) {
    for (const run of session.activeAgentRuns.values()) {
      run.detached = true;
    }
  } else {
    const target = captureSessionTarget({
      storeScope: session.sessionTarget.storePath,
      sessionKey: session.sessionTarget.canonicalKey,
      agentId: session.sessionTarget.agentId,
    });
    for (const [runId, run] of session.activeAgentRuns) {
      const current =
        run.standalone?.isCurrent() ||
        [...session.activeAgentToolCalls.values()].some(
          (registration) => registration.run === run && registration.isCurrent(),
        );
      const source =
        current && getRpcSourceForGateway(runId, session.context.resolveGatewayContext, target);
      if (source) {
        abortChatRunById(session.context, {
          runId,
          sessionKey: run.sessionKey,
          expectedEntry: source,
          stopReason: reason,
        });
      }
    }
  }
  session.activeAgentRuns.clear();
  session.activeAgentToolCalls.clear();
}

/** Drops one provider generation without sending cancellation into its replacement. */
export function resetTalkRealtimeRelayContinuity(
  session: RelaySession,
  reason = "session.continuity.reset",
): TalkEvent | undefined {
  session.toolResultEpoch += 1;
  const retiredCallIds = new Set<string>([
    ...session.activeAgentToolCalls.keys(),
    ...session.toolCalls.cancelledCallIds(),
    ...session.providerToolCallIds.keys(),
    ...session.providerToolCallIds.values(),
    ...session.pendingFinalToolResults.keys(),
    ...session.pendingProviderToolResults.keys(),
    ...session.pendingWorkingToolResults.keys(),
    ...session.forcedTerminalProviderResults.keys(),
  ]);
  for (const handle of session.harness.forcedConsults.handles()) {
    retiredCallIds.add(handle.id);
    for (const nativeCallId of session.harness.forcedConsults.nativeCallIds(handle)) {
      retiredCallIds.add(nativeCallId);
    }
  }
  if (!session.toolCalls.markAgentCompleted(retiredCallIds)) {
    return undefined;
  }
  session.toolCalls.clearCancelled();
  session.providerToolCallIds.clear();
  session.relayToolCallIdsByProviderId.clear();
  session.pendingFinalToolResults.clear();
  session.toolCalls.clearProviderCompleted();
  session.pendingProviderToolResults.clear();
  session.pendingWorkingToolResults.clear();
  session.forcedTerminalProviderResults.clear();
  session.harness.forcedConsults.clear();
  retireRelayAgentRuns(session, reason);
  const turnId = session.harness.talk.activeTurnId;
  session.harness.flushOutput(noFallbackRelayOutputFlush);
  session.harness.finishOutputAudio(reason);
  if (!turnId) {
    return undefined;
  }
  const cancelled = session.harness.talk.cancelTurn({
    turnId,
    payload: { reason },
  });
  return cancelled.ok ? cancelled.event : undefined;
}
