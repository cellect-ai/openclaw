import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import { resolveRealtimeVoiceProviderCapabilitiesAsync } from "../../../talk/provider-resolver.js";
import {
  type RealtimeVoiceBridge,
  type RealtimeVoiceBridgeCreateRequest,
} from "../../../talk/provider-types.js";
import { expectObjectFields as expectRecordFields } from "../../../test-utils/mock-call-assertions.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import {
  createIdleRelayProvider,
  ensureActiveRelayTurnId,
  makeRelayTransport,
} from "./index.test-support.js";
import {
  cancelTalkRealtimeRelayTurn,
  stopTalkRealtimeRelaySession as stopRelayRaw,
  submitTalkRealtimeRelayToolResult,
} from "./operations.js";
import { createTalkRealtimeRelaySession as createRelayRaw } from "./session-create.js";
import { usePersistentRelayTestState } from "./session-state.test-support.js";
import { relaySessions } from "./state.js";

const activeRelaySessions = new Map<string, string>();
const relayRunSettlements: Array<() => Promise<void>> = [];

const WORKING_RESULT = {
  status: "working",
  tool: "openclaw_agent_consult",
  message:
    "Tell the person briefly that you are checking, then wait for the final OpenClaw result before answering with the actual result.",
};

const DELIVERED_RESULT = {
  status: "already_delivered",
  message: "OpenClaw already delivered this consult result internally. Do not repeat it.",
};

type RelaySessionParams = Parameters<typeof createRelayRaw>[0];
type RelayFixtureDefaults = "connId" | "providerConfig" | "instructions" | "tools";

function stopRelay(params: Parameters<typeof stopRelayRaw>[0]): ReturnType<typeof stopRelayRaw> {
  const stopped = stopRelayRaw(params);
  activeRelaySessions.delete(params.relaySessionId);
  return stopped;
}

async function createRelay(
  params: Omit<RelaySessionParams, "sessionTarget" | "controlSource" | RelayFixtureDefaults> &
    Partial<Pick<RelaySessionParams, RelayFixtureDefaults>> & {
      sessionKey?: string;
      controlSource?: RelaySessionParams["controlSource"];
    },
): Promise<ReturnType<typeof createRelayRaw>> {
  const {
    sessionKey,
    connId = "conn-1",
    providerConfig = {},
    instructions = "brief",
    tools = [],
    ...request
  } = params;
  const cfg = params.cfg ?? { agents: { entries: { main: {} } } };
  const capabilities = await resolveRealtimeVoiceProviderCapabilitiesAsync({
    provider: params.provider,
    providerConfig,
    cfg,
    model: params.model,
    surface: "gateway-relay",
  });
  const session = createRelayRaw({
    ...request,
    connId,
    providerConfig,
    instructions,
    tools,
    controlSource:
      request.controlSource ??
      (capabilities?.handlesAgentConsult === true ? "delegation" : "transcript"),
    capabilities,
    context: request.context,
    cfg,
    sessionTarget: await prepareTalkSessionTarget(cfg, sessionKey ?? "agent:main:main"),
  });
  activeRelaySessions.set(session.relaySessionId, connId);
  return session;
}

function relayTarget(session: { relaySessionId: string }, connId = "conn-1") {
  return { relaySessionId: session.relaySessionId, connId };
}

function submitResult(
  session: { relaySessionId: string },
  callId: string,
  result: Parameters<typeof submitTalkRealtimeRelayToolResult>[0]["result"],
  options?: Parameters<typeof submitTalkRealtimeRelayToolResult>[0]["options"],
) {
  return submitTalkRealtimeRelayToolResult({ ...relayTarget(session), callId, result, options });
}

function cancelTurn(
  session: { relaySessionId: string },
  turnId?: string,
  reason?: Parameters<typeof cancelTalkRealtimeRelayTurn>[0]["reason"],
) {
  return cancelTalkRealtimeRelayTurn({ ...relayTarget(session), turnId, reason });
}

function toolCall(
  request: RealtimeVoiceBridgeCreateRequest | undefined,
  itemId: string,
  callId: string,
  name: string,
  args: Record<string, unknown> = {},
) {
  request?.onToolCall?.({ itemId, callId, name, args });
}

function consultCall(
  request: RealtimeVoiceBridgeCreateRequest | undefined,
  itemId: string,
  callId: string,
  question: string,
) {
  toolCall(request, itemId, callId, "openclaw_agent_consult", { question });
}

function eventPayloads(
  events: Array<{ payload: unknown }>,
  selector: string | ((payload: Record<string, unknown>) => boolean),
  callId?: string,
) {
  return events
    .map(({ payload }) => payload)
    .filter(
      (payload): payload is Record<string, unknown> =>
        typeof payload === "object" &&
        payload !== null &&
        (typeof selector === "string"
          ? (payload as Record<string, unknown>).type === selector
          : selector(payload as Record<string, unknown>)) &&
        (callId === undefined || (payload as Record<string, unknown>).callId === callId),
    );
}

function captureProvider(createBridge: () => RealtimeVoiceBridge = () => makeRelayTransport()) {
  let request: RealtimeVoiceBridgeCreateRequest | undefined;
  return {
    provider: createIdleRelayProvider((input) => {
      request = input;
      return createBridge();
    }),
    get request() {
      return request;
    },
  };
}

describe("talk realtime gateway relay", () => {
  usePersistentRelayTestState(activeRelaySessions, async () => {
    for (const finish of relayRunSettlements.splice(0)) {
      await finish();
    }
  });

  // Regression for #139278: forced consults must not disable interruption.

  function createRelayEventRecorder() {
    const events: Array<{
      event: string;
      payload: unknown;
      connIds: string[];
      opts?: { dropIfSlow?: boolean };
    }> = [];
    const context = {
      broadcastToConnIds: (
        event: string,
        payload: unknown,
        connIds: ReadonlySet<string>,
        opts?: { dropIfSlow?: boolean },
      ) => events.push({ event, payload, connIds: [...connIds], opts }),
    } as never;
    return { events, context };
  }

  async function createEventRelay(
    bridge: RealtimeVoiceBridge = makeRelayTransport(),
    options: Omit<Parameters<typeof createRelay>[0], "provider" | "context"> = {},
  ) {
    const captured = captureProvider(() => bridge);
    const { events, context } = createRelayEventRecorder();
    const session = await createRelay({
      context,
      provider: captured.provider,
      ...options,
    });
    await Promise.resolve();
    return { session, captured, events, bridge };
  }

  async function createMockRelay(
    bridge: RealtimeVoiceBridge = makeRelayTransport(),
    options: Omit<Parameters<typeof createRelay>[0], "provider" | "context"> = {},
  ) {
    const captured = captureProvider(() => bridge);
    const broadcastToConnIds = vi.fn();
    const session = await createRelay({
      context: { broadcastToConnIds } as never,
      provider: captured.provider,
      ...options,
    });
    return { session, captured, broadcastToConnIds };
  }

  async function createForcedConsultFixture(
    nativeCallIds: string[],
    options: {
      firstSubmission?: Promise<void>;
      supportsToolResultContinuation?: boolean;
      supportsToolResultSuppression?: boolean;
    } = {},
  ) {
    vi.useFakeTimers();
    const submitToolResult = vi.fn<RealtimeVoiceBridge["submitToolResult"]>();
    if (options.firstSubmission) {
      submitToolResult.mockReturnValueOnce(options.firstSubmission);
    }
    const sendUserMessage = vi.fn();
    const bridge = makeRelayTransport({
      supportsToolResultContinuation: options.supportsToolResultContinuation ?? false,
      supportsToolResultSuppression: options.supportsToolResultSuppression ?? false,
      sendUserMessage,
      submitToolResult,
    });
    const { session, captured, events } = await createEventRelay(bridge, {
      instructions: "be brief",
      forceAgentConsultOnFinalTranscript: true,
    });
    captured.request?.onTranscript?.("user", "Can you check this?", true);
    await vi.advanceTimersByTimeAsync(250);
    const forcedToolCall = findEventPayload(events, "toolCall", { forced: true });
    for (const callId of nativeCallIds) {
      consultCall(captured.request, `item-${callId}`, callId, "Can you check this?");
    }
    const callId = String(forcedToolCall.callId);
    return {
      bridgeRequest: captured.request,
      bridge,
      cancel: (reason?: string) =>
        cancelTurn(session, ensureActiveRelayTurnId(session.relaySessionId), reason),
      callId,
      submit: (
        result: Parameters<typeof submitResult>[2],
        resultOptions?: Parameters<typeof submitResult>[3],
      ) => submitResult(session, callId, result, resultOptions),
      events,
      sendUserMessage,
      session,
      submitToolResult,
    };
  }

  function findEventPayload(
    events: Array<{ payload: unknown }>,
    selector: string | ((payload: Record<string, unknown>) => boolean),
    fields: Record<string, unknown> = {},
  ) {
    return expectDefined(
      eventPayloads(events, selector).find((payload) =>
        Object.entries(fields).every(([key, value]) => payload[key] === value),
      ),
      "Expected matching relay event",
    );
  }

  it("forces an agent consult when configured and realtime transcript finalizes without a provider tool call", async () => {
    const fixture = await createForcedConsultFixture([], {
      supportsToolResultContinuation: true,
      supportsToolResultSuppression: true,
    });
    const { session, bridgeRequest, events, sendUserMessage, submitToolResult } = fixture;
    expectRecordFields(bridgeRequest, { autoRespondToAudio: false });
    expect(sendUserMessage).not.toHaveBeenCalledWith("Can you check this?");
    const forcedToolCall = findEventPayload(events, "toolCall", { forced: true });
    expect(forcedToolCall.args).toMatchObject({
      question: "Can you check this?",
      responseStyle: "Reply in a concise spoken tone.",
    });
    expect(fixture.bridge.handleBargeIn).toHaveBeenCalledWith({
      audioPlaybackActive: true,
      force: true,
    });

    const callId = String(forcedToolCall.callId);
    void submitResult(session, callId, { status: "working" }, { willContinue: true });
    expect(sendUserMessage).toHaveBeenLastCalledWith(
      "Briefly tell the person that you are checking with OpenClaw. Do not answer the request yet. Wait for the OpenClaw result before giving the actual answer.",
    );

    consultCall(bridgeRequest, "native-item", "native-call", "Can you check this?");
    expect(submitToolResult).toHaveBeenLastCalledWith("native-call", WORKING_RESULT, {
      willContinue: true,
    });

    const forcedAcceptance = createDeferred();
    submitToolResult.mockImplementationOnce(() => forcedAcceptance.promise);
    const forcedSubmission = submitResult(session, callId, {
      result: "Here is the checked answer.",
    });
    expect(sendUserMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("Here is the checked answer."),
    );
    forcedAcceptance.resolve();
    await forcedSubmission;
    expect(submitToolResult).toHaveBeenLastCalledWith("native-call", DELIVERED_RESULT, {
      suppressResponse: true,
    });
    expect(sendUserMessage).toHaveBeenLastCalledWith(
      expect.stringContaining("Here is the checked answer."),
    );
    expect(submitToolResult.mock.invocationCallOrder.at(-1)).toBeLessThan(
      sendUserMessage.mock.invocationCallOrder.at(-1) ?? 0,
    );
    expect(eventPayloads(events, "toolCall", "native-call")).toHaveLength(0);

    consultCall(
      bridgeRequest,
      "native-other-item",
      "native-other-call",
      "Can you check something else?",
    );
    expect(submitToolResult).toHaveBeenLastCalledWith("native-other-call", WORKING_RESULT, {
      willContinue: true,
    });
    expect(findEventPayload(events, "toolCall", { callId: "native-other-call" }).args).toEqual({
      question: "Can you check something else?",
    });
    void stopRelay({ relaySessionId: session.relaySessionId, connId: "conn-1" });
  });

  it.each([
    { label: "without native calls", nativeCallIds: [] },
    { label: "with a matching native call", nativeCallIds: ["native-call"] },
  ])("honors response suppression for forced consults $label", async ({ nativeCallIds }) => {
    const fixture = await createForcedConsultFixture(nativeCallIds, {
      supportsToolResultSuppression: true,
    });
    await fixture.submit({ status: "working" }, { willContinue: true, suppressResponse: true });
    const result = { result: "This answer was delivered elsewhere." };
    await fixture.submit(result, { suppressResponse: true });

    expect(fixture.sendUserMessage).not.toHaveBeenCalled();
    expect(fixture.submitToolResult).toHaveBeenCalledTimes(nativeCallIds.length);
    if (nativeCallIds.length > 0) {
      expect(fixture.submitToolResult).toHaveBeenCalledWith(
        "native-call",
        expect.objectContaining({ status: "already_delivered" }),
        { suppressResponse: true },
      );
    }
    expect(
      findEventPayload(
        fixture.events,
        (payload) =>
          payload.type === "toolResult" &&
          (payload.talkEvent as { final?: boolean } | undefined)?.final === true,
      ),
    ).toMatchObject({
      callId: fixture.callId,
      talkEvent: { type: "tool.result", payload: { result, forced: true }, final: true },
    });
  });

  it("classifies forced interim and terminal results only from willContinue", async () => {
    const fixture = await createForcedConsultFixture(["native-call"]);

    await fixture.submit({ phase: "checking" }, { willContinue: true });
    expect(fixture.submitToolResult).not.toHaveBeenCalled();

    await fixture.submit({ status: "working" });
    expect(fixture.submitToolResult).toHaveBeenCalledWith(
      "native-call",
      { status: "working" },
      undefined,
    );
    const finalStates = eventPayloads(fixture.events, "toolResult", fixture.callId).map(
      (payload) => (payload.talkEvent as { final?: boolean } | undefined)?.final,
    );
    expect(finalStates).toEqual([false, true]);
  });

  it("waits for every initial and late native result before publishing a forced result", async () => {
    const fixture = await createForcedConsultFixture(["native-1", "native-2"]);
    const first = createDeferred();
    const second = createDeferred();
    const third = createDeferred();
    const fourth = createDeferred();
    const thirdStarted = createDeferred();
    const fourthStarted = createDeferred();
    fixture.submitToolResult
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockImplementationOnce(() => {
        thirdStarted.resolve();
        return third.promise;
      })
      .mockImplementationOnce(() => {
        fourthStarted.resolve();
        return fourth.promise;
      });
    const submission = fixture.submit({ result: "checked" });
    expect(fixture.submit({ answer: "duplicate" })).toBe(submission);
    expect(fixture.submitToolResult.mock.calls).toEqual([
      ["native-1", { result: "checked" }, undefined],
      ["native-2", { result: "checked" }, undefined],
    ]);
    first.resolve();
    await Promise.resolve();
    expect(eventPayloads(fixture.events, "toolResult", fixture.callId)).toHaveLength(0);
    consultCall(fixture.bridgeRequest, "later-item", "native-3", "Can you check this?");
    second.resolve();
    await thirdStarted.promise;
    consultCall(fixture.bridgeRequest, "last-item", "native-4", "Can you check this?");
    third.resolve();
    await fourthStarted.promise;
    const settled = vi.fn();
    void Promise.resolve(submission).then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(eventPayloads(fixture.events, "toolResult", fixture.callId)).toHaveLength(0);
    fourth.resolve();
    await submission;
    expect(eventPayloads(fixture.events, "toolResult", fixture.callId)).toHaveLength(1);
    expect(fixture.submitToolResult.mock.calls.map((call) => call[0])).toEqual([
      "native-1",
      "native-2",
      "native-3",
      "native-4",
    ]);
    expect(fixture.sendUserMessage).not.toHaveBeenCalled();
    expect(
      eventPayloads(fixture.events, "toolResult").filter(({ callId }) =>
        ["native-2", "native-3", "native-4"].includes(String(callId)),
      ),
    ).toHaveLength(0);
  });

  it("retries only rejected native forced results after partial acceptance", async () => {
    const fixture = await createForcedConsultFixture(["native-1", "native-2"]);
    fixture.submitToolResult
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second native rejected"));
    const firstAttempt = fixture.submit({ answer: "checked" });
    await expect(firstAttempt).rejects.toThrow("second native rejected");
    expect(fixture.sendUserMessage).not.toHaveBeenCalled();

    await fixture.submit({ answer: "checked" });
    expect(fixture.submitToolResult.mock.calls.map((call) => call[0])).toEqual([
      "native-1",
      "native-2",
      "native-2",
    ]);
    expect(fixture.sendUserMessage).not.toHaveBeenCalled();
  });

  it("satisfies late native forced calls without suppression or duplicate speech", async () => {
    const fixture = await createForcedConsultFixture([]);
    await fixture.submit({ result: "checked" });
    expect(fixture.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(fixture.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("checked"));
    expect(fixture.submitToolResult).not.toHaveBeenCalled();

    consultCall(fixture.bridgeRequest, "late-item", "late-call", "Can you check this?");
    expect(fixture.submitToolResult).toHaveBeenCalledWith("late-call", DELIVERED_RESULT, undefined);
    expect(fixture.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported suppression before submitting a relay result", async () => {
    const bridge = makeRelayTransport({ supportsToolResultSuppression: false });
    const { session } = await createMockRelay(bridge);
    expect(() => submitResult(session, "call-1", { ok: true }, { suppressResponse: true })).toThrow(
      "Realtime provider does not support suppressed tool results",
    );
    expect(bridge.submitToolResult).not.toHaveBeenCalled();
  });

  it.each([
    { transcript: "Can you check this?", question: "Can you check this for me?" },
    { transcript: "проверь статус", question: "проверь статус" },
    { transcript: "Cancel this consult", question: undefined },
  ])("does not force a duplicate consult after $transcript", async ({ transcript, question }) => {
    vi.useFakeTimers();
    const { session, captured, events } = await createEventRelay(
      makeRelayTransport({
        supportsToolResultContinuation: true,
        sendUserMessage: vi.fn(),
        triggerGreeting: vi.fn(),
      }),
      { forceAgentConsultOnFinalTranscript: true },
    );
    captured.request?.onTranscript?.("user", transcript, true);
    if (question) {
      consultCall(captured.request, "item-1", "call-1", question);
    } else {
      void cancelTurn(session, ensureActiveRelayTurnId(session.relaySessionId), "barge-in");
    }
    await vi.advanceTimersByTimeAsync(250);
    expect(eventPayloads(events, "toolCall").some(({ forced }) => forced === true)).toBe(false);
    expect(relaySessions.has(session.relaySessionId)).toBe(true);
  });

  it("starts a tracked OpenClaw consult when provider-direct voice promises a check without calling it", async () => {
    vi.useFakeTimers();

    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const bridge = makeRelayTransport({
      supportsToolResultContinuation: true,
      sendUserMessage: vi.fn(),
      triggerGreeting: vi.fn(),
      submitToolResult: vi.fn(),
    });
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (req) => {
        bridgeRequest = req;
        return bridge;
      },
    };
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const context = {
      broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
        events.push({ event, payload, connIds: [...connIds] });
      },
    } as never;

    const session = await createRelay({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "be brief",
      tools: [],
      controlSource: "delegation",
    });
    await Promise.resolve();

    bridgeRequest?.onTranscript?.("user", "What does the $1,000 charge refer to?", true);
    bridgeRequest?.onEvent?.({
      direction: "server",
      type: "response.created",
      responseId: "response-checking-backchannel",
    });
    bridgeRequest?.onTranscript?.(
      "assistant",
      "Let me check what that charge refers to in your records.",
      true,
    );

    await vi.advanceTimersByTimeAsync(250);

    const forcedToolCall = findEventPayload(
      events,
      (payload) => payload.type === "toolCall" && payload.forced === true,
    );
    expectRecordFields(forcedToolCall, {
      relaySessionId: session.relaySessionId,
      type: "toolCall",
      name: "openclaw_agent_consult",
      forced: true,
    });
    expectRecordFields(forcedToolCall.args, {
      question: "What does the $1,000 charge refer to?",
      context:
        "The realtime provider promised to check the user's request but has not returned a result. Complete the original request with OpenClaw or report a clear failure or limitation.",
      responseStyle: "Reply in a concise spoken tone.",
    });
    expect(bridge.handleBargeIn).toHaveBeenCalledWith({
      audioPlaybackActive: true,
      force: true,
    });

    stopRelay({ relaySessionId: session.relaySessionId, connId: "conn-1" });
  });

  it("adopts a late native consult after a checking backchannel without scheduling a duplicate", async () => {
    vi.useFakeTimers();

    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const bridge = makeRelayTransport({
      supportsToolResultContinuation: true,
      sendUserMessage: vi.fn(),
      triggerGreeting: vi.fn(),
      submitToolResult: vi.fn(),
    });
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (req) => {
        bridgeRequest = req;
        return bridge;
      },
    };
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const context = {
      broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
        events.push({ event, payload, connIds: [...connIds] });
      },
    } as never;

    const session = await createRelay({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "be brief",
      tools: [],
      controlSource: "delegation",
    });
    await Promise.resolve();

    const question = "What is the current status of 305 Third?";
    bridgeRequest?.onTranscript?.("user", question, true);
    bridgeRequest?.onEvent?.({
      direction: "server",
      type: "response.created",
      responseId: "response-checking-backchannel",
    });
    bridgeRequest?.onTranscript?.("assistant", "Let me check that for you.", true);
    bridgeRequest?.onToolCall?.({
      itemId: "native-consult-item",
      callId: "native-consult-call",
      name: "openclaw_agent_consult",
      args: { question },
    });

    await vi.advanceTimersByTimeAsync(250);

    const consultCalls = events
      .map((event) => event.payload as { type?: string; name?: string; forced?: boolean })
      .filter(
        (payload) => payload.type === "toolCall" && payload.name === "openclaw_agent_consult",
      );
    expect(consultCalls).toHaveLength(1);
    expect(consultCalls[0]?.forced).toBeUndefined();

    stopRelay({ relaySessionId: session.relaySessionId, connId: "conn-1" });
  });

  it.each([false, true])(
    "cancels a scheduled checking consult when a newer user transcript arrives (final=%s)",
    async (final) => {
      vi.useFakeTimers();

      let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
      const bridge = makeRelayTransport({
        supportsToolResultContinuation: true,
        sendUserMessage: vi.fn(),
        triggerGreeting: vi.fn(),
        submitToolResult: vi.fn(),
      });
      const provider: RealtimeVoiceProviderPlugin = {
        id: "relay-test",
        label: "Relay Test",
        isConfigured: () => true,
        createBridge: (req) => {
          bridgeRequest = req;
          return bridge;
        },
      };
      const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
      const context = {
        broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
          events.push({ event, payload, connIds: [...connIds] });
        },
      } as never;

      const session = await createRelay({
        context,
        connId: "conn-1",
        provider,
        providerConfig: {},
        instructions: "be brief",
        tools: [],
        controlSource: "delegation",
      });
      await Promise.resolve();

      bridgeRequest?.onTranscript?.("user", "What does the $1,000 charge refer to?", true);
      bridgeRequest?.onEvent?.({
        direction: "server",
        type: "response.created",
        responseId: "response-checking-backchannel",
      });
      bridgeRequest?.onTranscript?.("assistant", "Let me check that for you.", true);
      bridgeRequest?.onTranscript?.("user", "Actually, check the $500 charge instead.", final);

      await vi.advanceTimersByTimeAsync(250);

      const forcedCalls = events.filter((event) => {
        const payload = event.payload as { type?: string; forced?: boolean };
        return payload.type === "toolCall" && payload.forced === true;
      });
      expect(forcedCalls).toHaveLength(0);

      stopRelay({ relaySessionId: session.relaySessionId, connId: "conn-1" });
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
