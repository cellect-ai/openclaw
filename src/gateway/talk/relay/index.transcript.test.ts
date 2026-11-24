import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import {
  readSessionTranscriptMessageEvents,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.js";
import { captureOpenClawStateDatabaseReadAdmission } from "../../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import {
  checkClientVoiceToolConfirmationPolicy,
  deactivateClientVoiceConfirmationSession,
} from "../../../talk/client-voice-confirmation.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import { resolveRealtimeVoiceProviderCapabilitiesAsync } from "../../../talk/provider-resolver.js";
import {
  type RealtimeVoiceBridge,
  type RealtimeVoiceBridgeCreateRequest,
} from "../../../talk/provider-types.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import {
  createIdleRelayProvider,
  makeRelayTransport,
  observeRelayTranscriptFailures,
} from "./index.test-support.js";
import {
  flushTalkRealtimeRelayVoiceWrites,
  registerTalkRealtimeRelayAgentRun,
  stopTalkRealtimeRelaySession as stopRelayRaw,
} from "./operations.js";
import { createTalkRealtimeRelaySession as createRelayRaw } from "./session-create.js";
import { usePersistentRelayTestState } from "./session-state.test-support.js";
import { drainingRelaySessions, relaySessions } from "./state.js";

const activeRelaySessions = new Map<string, string>();
const relayRunSettlements: Array<() => Promise<void>> = [];

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

function createRelayContext(overrides: Record<string, unknown> = {}) {
  return {
    broadcastToConnIds: vi.fn(),
    getRuntimeConfig: () => ({}),
    logGateway: { warn: vi.fn() },
    ...overrides,
  } as never;
}

function voiceRecord(session: { relaySessionId: string }) {
  return clientVoiceSessionTesting.readRecord("main", session.relaySessionId);
}

function relayTarget(session: { relaySessionId: string }, connId = "conn-1") {
  return { relaySessionId: session.relaySessionId, connId };
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
  const { cleanupIsolatedRelayState } = usePersistentRelayTestState(
    activeRelaySessions,
    async () => {
      for (const finish of relayRunSettlements.splice(0)) {
        await finish();
      }
    },
  );

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

  it.each([
    ["agent:main:main", "agent:main:main", "main", "per-sender" as const],
    ["main", "agent:main:work", "work", "per-sender" as const],
    ["agent:main:main", "global", "main", "global" as const],
  ])(
    "appends relay transcripts from %s to %s",
    async (sessionKey, canonicalKey, mainKey, scope) => {
      const outerStateAdmission = captureOpenClawStateDatabaseReadAdmission(
        resolveOpenClawStateSqlitePath(),
      );
      const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
      const tempDir = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-relay-voice-")),
      );
      setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
      const storePath = path.join(tempDir, "configured", "sessions.sqlite");
      const cfg: OpenClawConfig = { session: { store: storePath, mainKey, scope } };
      try {
        await replaceSessionEntry(
          { agentId: "main", sessionKey: canonicalKey, storePath },
          { sessionId: "relay-voice-session", updatedAt: Date.now() },
        );
        const captured = captureProvider();
        const session = await createRelay({
          context: createRelayContext(),
          connId: "conn-voice",
          cfg,
          provider: captured.provider,
          sessionKey,
        });
        captured.request?.onTranscript?.("user", "relay hello", true);
        captured.request?.onTranscript?.("assistant", "relay response", true);
        await flushTalkRealtimeRelayVoiceWrites(relayTarget(session, "conn-voice"));

        const events = readSessionTranscriptMessageEvents({
          agentId: "main",
          sessionId: "relay-voice-session",
          storePath,
        });
        expect(voiceRecord(session)).toMatchObject({
          agentId: "main",
          sessionKey,
          origin: "relay",
        });
        expect(events).toHaveLength(2);
        expect(events[0]?.event).toMatchObject({
          id: `voice:${session.relaySessionId}:1`,
          message: { role: "user", content: [{ type: "text", text: "relay hello" }] },
        });
        expect(events[1]?.event).toMatchObject({
          id: `voice:${session.relaySessionId}:2`,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "relay response" }],
            api: "realtime",
            provider: "relay-test",
            model: "realtime-voice",
          },
        });
        void stopRelay(relayTarget(session, "conn-voice"));
        await vi.waitFor(() => expect(voiceRecord(session)?.status).toBe("closed"));
      } finally {
        await cleanupIsolatedRelayState(tempDir);
        envSnapshot.restore();
        await fs.rm(tempDir, { recursive: true, force: true });
      }
      // Nested relay storage cannot revoke the beforeEach fixture or its worker leases.
      expect(() => outerStateAdmission.assertCurrent()).not.toThrow();
    },
  );

  it("emits one terminal error and close when transcript persistence overflows", async () => {
    setRuntimeConfigSnapshot({});
    const { promise: queueBlocked, resolve: releaseQueue } = createDeferred();
    try {
      await replaceSessionEntry(
        { agentId: "main", sessionKey: "agent:main:main" },
        { sessionId: "relay-voice-overflow-session", updatedAt: Date.now() },
      );
      const bridge = makeRelayTransport();
      const { session, captured, events } = await createEventRelay(bridge);
      const relay = relaySessions.get(session.relaySessionId);
      if (!relay) {
        throw new Error("expected active relay");
      }
      relay.voiceTranscriptQueue.enqueue(async () => await queueBlocked);

      for (let index = 0; index < 10_000; index += 1) {
        captured.request?.onTranscript?.("user", `message ${index}`, true);
      }

      const errorPayloads = eventPayloads(events, "error");
      const closePayloads = eventPayloads(events, "close");
      expect(errorPayloads).toMatchObject([
        { message: expect.stringContaining("persistence could not keep up") },
      ]);
      expect(errorPayloads[0]).not.toHaveProperty("code");
      expect(closePayloads).toMatchObject([{ reason: "error" }]);
      expect(bridge.close).toHaveBeenCalledOnce();
      expect(relaySessions.has(session.relaySessionId)).toBe(false);
      expect(drainingRelaySessions.has(relay)).toBe(true);

      const createAnother = () =>
        createRelay({
          context: createRelayContext(),
          provider: createIdleRelayProvider(),
        });
      await createAnother();
      await expect(createAnother()).rejects.toThrow(
        "Too many active realtime relay sessions for this connection",
      );

      releaseQueue();
      await relay.voiceSessionClose;
      expect(drainingRelaySessions.has(relay)).toBe(false);
      expect(voiceRecord(session)?.status).toBe("closed");
    } finally {
      releaseQueue();
    }
  });

  it("logs relay transcript append failures", async () => {
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    const tempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-relay-voice-failure-")),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const warn = vi.fn();
    const failures = observeRelayTranscriptFailures();
    try {
      vi.useFakeTimers();
      const captured = captureProvider();
      const session = await createRelay({
        context: createRelayContext({ logGateway: { warn } }),
        connId: "conn-voice-failure",
        cfg: {},
        provider: captured.provider,
        sessionKey: "agent:main:missing",
      });
      captured.request?.onTranscript?.("user", "cannot persist", true);
      await failures.afterAttempt(0);
      expect(warn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      await failures.afterAttempt(1);
      expect(warn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_999);
      expect(warn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await flushTalkRealtimeRelayVoiceWrites(relayTarget(session, "conn-voice-failure"));

      expect(warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("realtime relay transcript append failed"),
      );
      await stopRelay(relayTarget(session, "conn-voice-failure"));
      expect(voiceRecord(session)?.status).toBe("closed");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      failures.restore();
      await cleanupIsolatedRelayState(tempDir);
      envSnapshot.restore();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each(["main", "agent:main:main"])(
    "creates the relay voice record from %s and rejects a mismatched consult session",
    async (requestedKey) => {
      const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
      const tempDir = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-relay-voice-consult-")),
      );
      setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
      try {
        const session = await createRelay({
          context: {
            broadcastToConnIds: vi.fn(),
            chatAbortControllers: new Map(),
            getRuntimeConfig: () => ({}),
            logGateway: { warn: vi.fn() },
          } as never,
          connId: "conn-consult",
          cfg: {},
          provider: createIdleRelayProvider(),
          sessionKey: "agent:main:main",
        });
        expect(
          clientVoiceSessionTesting.readRecord("main", session.relaySessionId),
        ).toBeUndefined();

        await registerTalkRealtimeRelayAgentRun({
          relaySessionId: session.relaySessionId,
          connId: "conn-consult",
          sessionKey: requestedKey,
          runId: "run-before-transcript",
        });
        await expect(
          registerTalkRealtimeRelayAgentRun({
            relaySessionId: session.relaySessionId,
            connId: "conn-consult",
            sessionKey: "agent:main:other",
            runId: "run-other-session",
          }),
        ).rejects.toThrow("Realtime relay session belongs to another agent session");
        const relay = relaySessions.get(session.relaySessionId);
        expect(relay?.activeAgentRuns.size).toBe(1);
        expect(relay?.activeAgentRuns.get("run-before-transcript")?.sessionKey).toBe(
          "agent:main:main",
        );
        expect(relay?.activeAgentRuns.has("run-other-session")).toBe(false);

        expect(clientVoiceSessionTesting.readRecord("main", session.relaySessionId)).toMatchObject({
          status: "open",
          consultRunIds: ["run-before-transcript"],
        });
        void stopRelay({
          relaySessionId: session.relaySessionId,
          connId: "conn-consult",
        });
        await vi.waitFor(() =>
          expect(clientVoiceSessionTesting.readRecord("main", session.relaySessionId)?.status).toBe(
            "closed",
          ),
        );
      } finally {
        await cleanupIsolatedRelayState(tempDir);
        clientVoiceSessionTesting.reset();
        envSnapshot.restore();
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    },
  );

  it("logs a missing-session transcript failure and closes without confirming it", async () => {
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    const tempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-relay-voice-failure-")),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const warn = vi.fn();
    const failures = observeRelayTranscriptFailures();
    try {
      vi.useFakeTimers();
      const captured = captureProvider();
      const session = await createRelay({
        context: createRelayContext({ logGateway: { warn } }),
        connId: "conn-voice-failure",
        cfg: {},
        provider: captured.provider,
        sessionKey: "agent:main:missing",
      });
      captured.request?.onTranscript?.("user", "cannot persist", true);
      // Each retry sleep is armed only after the previous attempt fails. Advancing
      // the clock before that arms the timer leaves flush waiting forever.
      await failures.afterAttempt(0);
      expect(warn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      await failures.afterAttempt(1);
      expect(warn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_999);
      expect(warn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await flushTalkRealtimeRelayVoiceWrites(relayTarget(session, "conn-voice-failure"));

      expect(warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("agent session not found (agent:main:missing)"),
      );
      await stopRelay(relayTarget(session, "conn-voice-failure"));
      const record = voiceRecord(session);
      expect(record?.status).toBe("closed");
      // retain-and-close ends the relay call. The missing session never confirmed a transcript.
      expect(record?.hasUserTranscript).not.toBe(true);
      expect(record?.transcriptFailureKeys ?? []).toEqual([]);
    } finally {
      failures.restore();
      vi.useRealTimers();
      await cleanupIsolatedRelayState(tempDir);
      envSnapshot.restore();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("settles relay confirmation readiness on a noise final without publishing it or granting a write", async () => {
    let request: RealtimeVoiceBridgeCreateRequest | undefined;
    const provider = createIdleRelayProvider((req) => {
      request = req;
      return makeRelayTransport({});
    });
    const { events, context } = createRelayEventRecorder();
    const session = await createRelay({ context, provider });
    await Promise.resolve();
    const policy = {
      agentId: "main",
      voiceSessionId: session.relaySessionId,
      runId: "original",
      toolName: "message",
      toolParams: { action: "send", message: "hello" },
    };
    expect(checkClientVoiceToolConfirmationPolicy(policy).allowed).toBe(false);
    request?.onTranscript?.("user", "yes", false);
    const owner = relaySessions.get(session.relaySessionId)!;
    const pending = owner.transcriptReadiness.wait();
    await nextEventLoopTurn();
    request?.onTranscript?.("user", "[noise] ...", true);
    await expect(pending).resolves.toBeUndefined();
    expect(owner.voiceTranscriptSeq).toBe(0);
    expect(
      events.some((entry) => (entry.payload as { text?: string }).text === "[noise] ..."),
    ).toBe(false);
    expect(checkClientVoiceToolConfirmationPolicy(policy).allowed).toBe(false);
    stopRelay({ relaySessionId: session.relaySessionId, connId: "conn-1" });
    deactivateClientVoiceConfirmationSession("main", session.relaySessionId);
  });

  it("forwards input transcript item identity and delta semantics through the session harness", async () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const provider = createIdleRelayProvider();
    provider.createBridge = (request) => {
      bridgeRequest = request;
      return makeRelayTransport();
    };
    const broadcastToConnIds = vi.fn();
    const created = await createRelay({
      context: { broadcastToConnIds } as never,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });
    bridgeRequest?.onEvent?.({
      direction: "server",
      type: "input_audio_buffer.speech_started",
      itemId: "input-1",
    });
    bridgeRequest?.onTranscript?.("user", "cription", false, {
      itemId: "input-1",
      textMode: "delta",
    });
    expect(broadcastToConnIds.mock.calls.map(([, payload]) => payload)).toContainEqual(
      expect.objectContaining({
        type: "transcript",
        role: "user",
        text: "cription",
        final: false,
        itemId: "input-1",
        textMode: "delta",
      }),
    );
    expect(broadcastToConnIds.mock.calls.map(([, payload]) => payload)).toContainEqual(
      expect.objectContaining({
        type: "inputAudioStart",
        itemId: "input-1",
        relaySessionId: created.relaySessionId,
      }),
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
