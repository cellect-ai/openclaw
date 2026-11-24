import { createHash, randomUUID } from "node:crypto";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import type { RealtimeVoiceAgentConsultRunner } from "../../../talk/provider-types.js";

export const RELAY_DIAGNOSTIC_PROVIDER_EVENTS = new Set([
  "input_audio_buffer.speech_started",
  "input_audio_buffer.speech_stopped",
  "response.cancel",
  "response.cancelled",
  "response.created",
  "response.create",
  "response.done",
]);

export const RELAY_DIAGNOSTIC_RESPONSE_STATUSES = new Set([
  "completed",
  "cancelled",
  "failed",
  "incomplete",
]);

export type RelayOutputOwnershipFailureSite =
  | "response-created"
  | "audio"
  | "clear"
  | "mark"
  | "assistant-transcript"
  | "tool-call";

export const noFallbackRelayOutputFlush = () => {};

export class TalkRealtimeRelayOutputOwnership {
  mode: "turn-bound" | "exact-response" = "turn-bound";
  phase: "unowned" | "owned" | "cancelling" | "discarding" = "unowned";
  outputGeneration = 0;
  turnId?: string;
  responseId?: string;
  drain?: { promise: Promise<void>; resolve: () => void };
  private cancelledTerminal?: { responseId?: string };
  // OpenAI and xAI deliver completed function calls from the terminal response
  // callback after onResponseDone. Keep that response's turn available for the
  // synchronous tool callback, but fence it as soon as a replacement response
  // is created.
  private terminalToolTurnId?: string;
  private superseded = false;
  private readonly diagnosticSalt = randomUUID();
  private readonly diagnosticStartedAtMs = Date.now();
  private readonly recentProviderEvents: Array<Record<string, unknown>> = [];
  private lastProviderEvent?: Record<string, unknown>;

  constructor(
    private readonly activeTurnId: () => string | undefined,
    private readonly ensureTurn: () => string,
    private readonly fail: (message: string, diagnostics?: Record<string, unknown>) => void,
    private readonly continuousOutput: () => boolean,
  ) {}

  get discarding(): boolean {
    return this.phase === "discarding";
  }

  isDiscarding(generation: number): boolean {
    return this.discarding && this.outputGeneration === generation;
  }

  get suppressingOutput(): boolean {
    return this.phase === "cancelling" || this.discarding;
  }

  private hashDiagnosticId(value: string | undefined): string | undefined {
    const normalized = value?.trim();
    if (!normalized) {
      return undefined;
    }
    return createHash("sha256")
      .update(`${this.diagnosticSalt}:${normalized}`)
      .digest("hex")
      .slice(0, 10);
  }

  private recordProviderEvent(event: {
    direction: string;
    type: string;
    responseId?: string;
    itemId?: string;
    status?: string;
    callback?: "onResponseDone";
  }): void {
    const response = this.hashDiagnosticId(event.responseId);
    const item = this.hashDiagnosticId(event.itemId);
    const ownerResponse = this.hashDiagnosticId(this.responseId);
    const ownerTurn = this.hashDiagnosticId(this.turnId);
    const activeTurn = this.hashDiagnosticId(this.activeTurnId());
    const eventType = /^[a-z][a-z0-9_.-]{0,63}$/.test(event.type) ? event.type : "unknown";
    const status =
      event.status && RELAY_DIAGNOSTIC_RESPONSE_STATUSES.has(event.status)
        ? event.status
        : undefined;
    const summary = {
      offsetMs: Math.max(0, Date.now() - this.diagnosticStartedAtMs),
      direction:
        event.direction === "server" || event.direction === "client" ? event.direction : "unknown",
      type: eventType,
      ...(event.callback ? { callback: event.callback } : {}),
      ...(status ? { status } : {}),
      ...(response ? { response } : {}),
      ...(item ? { item } : {}),
      ownerPhase: this.phase,
      ownerMode: this.mode,
      ...(ownerResponse ? { ownerResponse } : {}),
      ...(ownerTurn ? { ownerTurn } : {}),
      ...(activeTurn ? { activeTurn } : {}),
    };
    this.lastProviderEvent = summary;
    if (!RELAY_DIAGNOSTIC_PROVIDER_EVENTS.has(event.type) && !event.callback) {
      return;
    }
    this.recentProviderEvents.push(summary);
    if (this.recentProviderEvents.length > 24) {
      this.recentProviderEvents.shift();
    }
  }

  private diagnosticSnapshot(
    failureSite: RelayOutputOwnershipFailureSite,
  ): Record<string, unknown> {
    const ownerResponse = this.hashDiagnosticId(this.responseId);
    const ownerTurn = this.hashDiagnosticId(this.turnId);
    const activeTurn = this.hashDiagnosticId(this.activeTurnId());
    return {
      failureSite,
      ownerPhase: this.phase,
      ownerMode: this.mode,
      ...(ownerResponse ? { ownerResponse } : {}),
      ...(ownerTurn ? { ownerTurn } : {}),
      ...(activeTurn ? { activeTurn } : {}),
      ...(this.lastProviderEvent ? { lastProviderEvent: this.lastProviderEvent } : {}),
      recentProviderEvents: [...this.recentProviderEvents],
    };
  }

  responseCreated(responseId: string | undefined): boolean {
    const normalizedResponseId = responseId?.trim();
    if (this.discarding) {
      if (!normalizedResponseId || normalizedResponseId === this.responseId) {
        return false;
      }
      this.finish(this.responseId);
    }
    if (this.phase === "unowned") {
      this.cancelledTerminal = undefined;
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
    // Grok and LiteLLM open the next response without a terminal event for the
    // one still owned. Keep the call and let that response take over. A response
    // that arrives while cancellation is unconfirmed stays fatal.
    if (
      this.phase === "owned" &&
      normalizedResponseId &&
      normalizedResponseId !== this.responseId
    ) {
      this.superseded = true;
      this.terminalToolTurnId = undefined;
      this.responseId = normalizedResponseId;
      return true;
    }
    this.fail(
      "Realtime provider output has no live response owner.",
      this.diagnosticSnapshot("response-created"),
    );
    return false;
  }

  resolve(claim: boolean, failureSite: RelayOutputOwnershipFailureSite): string | undefined {
    if (this.discarding) {
      return undefined;
    }
    // Continuous transports never send response.created, so output that arrives
    // before client input starts its own turn, as an ID-less response does.
    const activeTurnId =
      this.activeTurnId() ??
      (claim && this.phase === "unowned" && this.continuousOutput()
        ? this.ensureTurn()
        : undefined);
    if (activeTurnId && this.mode === "turn-bound" && claim && this.phase === "unowned") {
      this.cancelledTerminal = undefined;
      Object.assign(this, { phase: "owned" as const, turnId: activeTurnId });
    }
    const turnId =
      this.phase === "owned" && this.turnId === activeTurnId ? activeTurnId : undefined;
    if (!turnId && (claim || this.phase === "owned")) {
      this.fail(
        "Realtime provider output has no live response owner.",
        this.diagnosticSnapshot(failureSite),
      );
    }
    return turnId;
  }

  resolveToolCall(): string | undefined {
    if (this.suppressingOutput) {
      return undefined;
    }
    const activeTurnId = this.activeTurnId();
    if (this.phase === "owned") {
      return this.resolve(true, "tool-call");
    }
    if (activeTurnId && this.mode === "turn-bound") {
      return this.resolve(true, "tool-call");
    }
    if (this.terminalToolTurnId && (!activeTurnId || activeTurnId === this.terminalToolTurnId)) {
      return this.terminalToolTurnId;
    }
    this.fail(
      "Realtime provider output has no live response owner.",
      this.diagnosticSnapshot("tool-call"),
    );
    return undefined;
  }

  takeSuperseded(): boolean {
    const superseded = this.superseded;
    this.superseded = false;
    return superseded;
  }

  clearTerminalToolOwner(): void {
    this.terminalToolTurnId = undefined;
  }

  finish(responseId: string | undefined, cancellationEvent = false, allowTerminalTools = false) {
    const cancelled = this.suppressingOutput;
    if (
      (cancellationEvent && !cancelled) ||
      (this.mode === "exact-response" &&
        (this.phase === "unowned" || this.responseId !== responseId))
    ) {
      return "ignore";
    }
    this.terminalToolTurnId = allowTerminalTools && !cancelled ? this.turnId : undefined;
    this.drain?.resolve();
    Object.assign(this, { phase: "unowned" as const, turnId: undefined, responseId: undefined });
    return cancelled ? "cancelled" : "completed";
  }

  /** Resume input without releasing the unconfirmed provider response's output ownership. */
  completeCancellationLocally(): number | undefined {
    if (this.phase !== "cancelling") {
      return undefined;
    }
    this.phase = "discarding";
    this.drain?.resolve();
    return ++this.outputGeneration;
  }

  resetContinuity(): void {
    this.outputGeneration += 1;
    this.cancelledTerminal = undefined;
    this.terminalToolTurnId = undefined;
    this.drain?.resolve();
    Object.assign(this, { phase: "unowned" as const, turnId: undefined, responseId: undefined });
  }

  bind(
    provider: RealtimeVoiceProviderPlugin,
    runAgentConsult: RealtimeVoiceAgentConsultRunner,
  ): RealtimeVoiceProviderPlugin {
    return {
      ...provider,
      createBridge: (request) =>
        provider.createBridge({
          ...request,
          onEvent: (event) => {
            if (event.direction === "server" || RELAY_DIAGNOSTIC_PROVIDER_EVENTS.has(event.type)) {
              this.recordProviderEvent(event);
            }
            if (event.direction === "server") {
              if (event.type === "response.done" || event.type === "response.cancelled") {
                if (
                  this.cancelledTerminal &&
                  this.cancelledTerminal.responseId === event.responseId
                ) {
                  this.cancelledTerminal = undefined;
                  return;
                }
                if (this.suppressingOutput) {
                  this.finish(event.responseId, true);
                  return;
                }
              }
              if (event.type === "response.created" && !this.responseCreated(event.responseId)) {
                return;
              }
            }
            request.onEvent?.(event);
          },
          onResponseDone: (outcome) => {
            this.recordProviderEvent({
              direction: "server",
              type: "response.done",
              responseId: outcome.responseId,
              status: outcome.status,
              callback: "onResponseDone",
            });
            // The Talk turn is already cancelled. Settle its provider owner before the
            // harness rejects that terminal or mistakes it for a successor input turn.
            if (this.suppressingOutput) {
              if (this.finish(outcome.responseId) !== "ignore") {
                // Typed providers may emit a diagnostic legacy twin in the same dispatch.
                this.cancelledTerminal = { responseId: outcome.responseId };
              }
              return;
            }
            request.onResponseDone?.(outcome);
          },
          runAgentConsult,
        }),
    };
  }
}
