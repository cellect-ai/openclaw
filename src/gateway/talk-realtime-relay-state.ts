import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../config/types.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import type { BoundedSerialQueue } from "../shared/bounded-serial-queue.js";
import type { RealtimeVoiceAgentControlResult } from "../talk/agent-run-control.js";
import type {
  RealtimeVoiceBrowserAudioContract,
  RealtimeVoiceCloseDisposition,
  RealtimeVoiceAudioClearReason,
  RealtimeVoiceAgentConsultRunner,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceTool,
  RealtimeVoiceToolResultOptions,
  RealtimeVoiceTranscriptUpdate,
} from "../talk/provider-types.js";
import type { RealtimeVoiceSessionHarness } from "../talk/realtime-session-harness.js";
import type { RealtimeVoiceBridgeSession } from "../talk/session-runtime.js";
import type { TalkEvent } from "../talk/talk-session-controller.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";
import type { TalkAgentConsultAuthority } from "./talk-client-gateway-control.js";
import type { RelayToolCallLedger } from "./talk-realtime-relay-tool-call-ledger.js";

export const RELAY_SESSION_TTL_MS = 30 * 60 * 1000;
export const MAX_AUDIO_BASE64_BYTES = 512 * 1024;
export const MAX_RELAY_SESSIONS_PER_CONN = 2;
export const MAX_RELAY_SESSIONS_GLOBAL = 64;
const RELAY_EVENT = "talk.event";
export const RELAY_TRANSCRIPT_ECHO_LOOKBACK_MS = 12_000;

export const noFallbackRelayOutputFlush = () => {};

export type TalkRealtimeRelayEventPayload =
  | { relaySessionId: string; type: "ready" }
  | { relaySessionId: string; type: "inputAudio"; byteLength: number }
  | { relaySessionId: string; type: "inputAudioStart"; itemId: string }
  | {
      relaySessionId: string;
      type: "audio";
      audioBase64: string;
      itemId?: string;
      responseId?: string;
    }
  | { relaySessionId: string; type: "audioDone"; itemId?: string; responseId?: string }
  | { relaySessionId: string; type: "clear"; reason?: RealtimeVoiceAudioClearReason }
  | { relaySessionId: string; type: "mark"; markName: string }
  | ({
      relaySessionId: string;
      type: "transcript";
      role: "user" | "assistant";
      text: string;
      final: boolean;
    } & Partial<RealtimeVoiceTranscriptUpdate>)
  | {
      relaySessionId: string;
      type: "toolCall";
      itemId: string;
      callId: string;
      name: string;
      args: unknown;
      forced?: boolean;
    }
  | { relaySessionId: string; type: "toolCallCancelled"; callId: string }
  | { relaySessionId: string; type: "toolResult"; callId: string }
  | { relaySessionId: string; type: "toolProgress"; result: RealtimeVoiceAgentControlResult }
  | {
      relaySessionId: string;
      type: "error";
      message: string;
      code?: "realtime_unavailable";
      provider?: string;
      model?: string;
      transport?: "gateway-relay";
      phase?: string;
    }
  | { relaySessionId: string; type: "close"; reason: "completed" | "error" };

type TalkRealtimeRelayEvent = TalkRealtimeRelayEventPayload & { talkEvent?: TalkEvent };

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

type RelayProvider = RealtimeVoiceProviderPlugin;
export class TalkRealtimeRelayOutputOwnership {
  mode: "turn-bound" | "exact-response" = "turn-bound";
  phase: "unowned" | "owned" | "cancelling" = "unowned";
  outputGeneration = 0;
  turnId?: string;
  responseId?: string;
  drain?: { promise: Promise<void>; resolve: () => void };
  // OpenAI and xAI deliver completed function calls from the terminal response
  // callback after onResponseDone. Keep that response's turn available for the
  // synchronous tool callback, but fence it as soon as a replacement response
  // is created.
  private terminalToolTurnId?: string;

  constructor(
    private readonly activeTurnId: () => string | undefined,
    private readonly ensureTurn: () => string,
    private readonly fail: (message: string) => void,
  ) {}

  responseCreated(responseId: string | undefined): boolean {
    const normalizedResponseId = responseId?.trim();
    if (this.phase === "unowned") {
      this.terminalToolTurnId = undefined;
      Object.assign(this, {
        mode: normalizedResponseId ? ("exact-response" as const) : ("turn-bound" as const),
        phase: "owned" as const,
        turnId: this.ensureTurn(),
        responseId: normalizedResponseId,
      });
      return true;
    }
    if (
      this.phase === "owned" &&
      this.mode === "exact-response" &&
      normalizedResponseId &&
      normalizedResponseId === this.responseId
    ) {
      return true;
    }
    this.fail("Realtime provider output has no live response owner.");
    return false;
  }

  resolve(claim: boolean): string | undefined {
    const activeTurnId = this.activeTurnId();
    if (
      this.phase !== "cancelling" &&
      activeTurnId &&
      this.mode === "turn-bound" &&
      claim &&
      this.phase === "unowned"
    ) {
      Object.assign(this, { phase: "owned" as const, turnId: activeTurnId });
    }
    const turnId =
      this.phase === "owned" && this.turnId === activeTurnId ? activeTurnId : undefined;
    if (!turnId && (claim || this.phase === "owned")) {
      this.fail("Realtime provider output has no live response owner.");
    }
    return turnId;
  }

  resolveToolCall(): string | undefined {
    const activeTurnId = this.activeTurnId();
    if (this.phase === "cancelling") {
      return undefined;
    }
    if (this.phase === "owned") {
      return this.resolve(true);
    }
    if (activeTurnId && this.mode === "turn-bound") {
      return this.resolve(true);
    }
    if (this.terminalToolTurnId && (!activeTurnId || activeTurnId === this.terminalToolTurnId)) {
      return this.terminalToolTurnId;
    }
    this.fail("Realtime provider output has no live response owner.");
    return undefined;
  }

  clearTerminalToolOwner(): void {
    this.terminalToolTurnId = undefined;
  }

  finish(responseId: string | undefined, cancellationEvent = false, allowTerminalTools = false) {
    const cancelled = this.phase === "cancelling";
    if (
      (cancellationEvent && !cancelled) ||
      (this.mode === "exact-response" &&
        (this.phase === "unowned" || this.responseId !== responseId))
    ) {
      return "ignore";
    }
    this.terminalToolTurnId = allowTerminalTools ? this.turnId : undefined;
    this.drain?.resolve();
    Object.assign(this, { phase: "unowned" as const, turnId: undefined, responseId: undefined });
    return cancelled ? "cancelled" : "completed";
  }

  bind(provider: RelayProvider, runAgentConsult: RealtimeVoiceAgentConsultRunner): RelayProvider {
    return {
      ...provider,
      createBridge: (request) =>
        provider.createBridge({
          ...request,
          onEvent: (event) => {
            if (
              event.direction === "server" &&
              event.type === "response.created" &&
              !this.responseCreated(event.responseId)
            ) {
              return;
            }
            request.onEvent?.(event);
          },
          runAgentConsult,
        }),
    };
  }
}

export type RelaySession = {
  id: string;
  connId: string;
  context: GatewayRequestContext;
  bridge: RealtimeVoiceBridgeSession;
  harness: RealtimeVoiceSessionHarness;
  outputOwnership: TalkRealtimeRelayOutputOwnership;
  sessionKey?: string;
  agentId?: string;
  speakerMxid?: string;
  closeDisposition?: RealtimeVoiceCloseDisposition;
  matrixRoute?: { channel: "matrix"; roomId: string; threadRootEventId: string; accountId: string };
  expiresAtMs: number;
  cleanupTimer: ReturnType<typeof setTimeout>;
  activeAgentRuns: Map<string, string>;
  provider: string;
  activeAgentToolCalls: Map<string, string>;
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
  voiceSessionCreated: boolean;
  voiceTranscriptSeq: number;
  voiceTranscriptQueue: BoundedSerialQueue;
  voiceSessionClose?: Promise<void>;
  failSession: (message: string) => void;
  pendingVoiceTranscripts: Array<{ role: "user" | "assistant"; text: string }>;
};

export type CreateTalkRealtimeRelaySessionParams = {
  context: GatewayRequestContext;
  connId: string;
  cfg?: OpenClawConfig;
  consultAuthority?: TalkAgentConsultAuthority;
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
  instructions: string;
  /** Untrusted client context captured at session creation for delegated consults. */
  sessionContext?: string;
  tools: RealtimeVoiceTool[];
  model?: string;
  sessionKey?: string;
  voice?: string;
  language?: string;
  forceAgentConsultOnFinalTranscript?: boolean;
  speakerMxid?: string;
  matrixRoute?: { channel: "matrix"; roomId: string; threadRootEventId: string; accountId: string };
};

export type TalkRealtimeRelaySessionResult = {
  provider: string;
  transport: "gateway-relay";
  relaySessionId: string;
  audio: RealtimeVoiceBrowserAudioContract;
  model?: string;
  voice?: string;
  expiresAt: number;
};

export const relaySessions = new Map<string, RelaySession>();

/** Resolve browser capabilities only against their live connection-owned relay. */
export function resolveOwnedTalkRealtimeRelaySession(
  relaySessionId: string,
  connId: string | undefined,
): RelaySession | undefined {
  const relay = relaySessions.get(relaySessionId);
  return connId && relay?.connId === connId && relay.expiresAtMs >= Date.now() ? relay : undefined;
}
// Closed relays leave the active map immediately so late provider/client events
// are ignored, but their accepted transcript prefix still owns bounded memory
// until durable close settles. Session limits count both maps.
export const drainingRelaySessions = new Set<RelaySession>();

export function adoptRelayProviderToolCallId(
  session: RelaySession,
  providerCallId: string,
): string | undefined {
  const current = session.relayToolCallIdsByProviderId.get(providerCallId);
  if (current) {
    if (
      session.toolCalls.isAgentCompleted(current) ||
      session.toolCalls.isProviderCompleted(providerCallId)
    ) {
      return undefined;
    }
    return current;
  }
  const relayCallId = session.toolCalls.isAgentCompleted(providerCallId)
    ? `relay-${randomUUID()}`
    : providerCallId;
  // Realtime protocols define no replay window. Retain every admitted identity
  // for the session and fail closed at the hard cap instead of evicting dedupe state.
  if (!session.toolCalls.tryAdmit([providerCallId, relayCallId])) {
    return undefined;
  }
  session.toolCalls.deleteProviderCompleted(providerCallId);
  session.toolCalls.deleteAgentCompleted(relayCallId);
  session.providerToolCallIds.set(relayCallId, providerCallId);
  session.relayToolCallIdsByProviderId.set(providerCallId, relayCallId);
  return relayCallId;
}

export function resolveRelayProviderToolCallId(session: RelaySession, relayCallId: string): string {
  return session.providerToolCallIds.get(relayCallId) ?? relayCallId;
}

export function broadcastToOwner(
  context: GatewayRequestContext,
  connId: string,
  event: TalkRealtimeRelayEvent,
): void {
  // Classify the materialized Talk event so final results cannot be mistaken
  // for transient tool progress by individual provider callback paths.
  const delivery = relayEventDeliveryOptions(event, event.talkEvent);
  context.broadcastToConnIds(RELAY_EVENT, event, new Set([connId]), delivery);
}

function relayEventDeliveryOptions(
  event: TalkRealtimeRelayEventPayload,
  talkEvent?: TalkEvent,
): {
  dropIfSlow?: boolean;
} {
  switch (event.type) {
    case "audio":
    case "inputAudio":
      return { dropIfSlow: true };
    case "transcript":
      return { dropIfSlow: !event.final };
    case "toolProgress":
    case "toolResult":
      return { dropIfSlow: talkEvent?.final !== true };
    default:
      return { dropIfSlow: false };
  }
}

export function ensureRelayTurn(session: RelaySession): string {
  const turn = session.harness.talk.ensureTurn();
  if (turn.event) {
    broadcastToOwner(session.context, session.connId, {
      relaySessionId: session.id,
      type: "inputAudio",
      byteLength: 0,
      talkEvent: turn.event,
    });
  }
  return turn.turnId;
}
