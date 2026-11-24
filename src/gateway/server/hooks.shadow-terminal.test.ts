import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";

const enqueueSystemEventMock = vi.fn();
const requestHeartbeatMock = vi.fn();
// 11.7 delivers hook terminals as session events into the captured target.
const captureSessionEventTargetMock = vi.fn(async (agentId: string, sessionKey: string) => ({
  agentId,
  sessionKey,
  sessionId: "captured-session",
  generation: "captured-generation",
}));
const enqueueSessionEventMock = vi.fn((_text: string, _options: Record<string, unknown>) => ({
  accepted: Promise.resolve({ ok: true }),
  settled: Promise.resolve({ status: "completed" }),
}));
const runCronIsolatedAgentTurnMock = vi.fn();
const loadConfigMock = vi.fn(
  (): OpenClawConfig =>
    ({
      agents: { entries: { main: {} } },
      // A hook naming a Fi environment is admitted only with that environment's route.
      plugins: {
        entries: {
          "fi-user": {
            config: {
              matrixEnvironments: {
                dev: { baseUrl: "https://dev.fi.example", brokerTokenEnv: "BROKER_DEV" },
              },
            },
          },
        },
      },
    }) as OpenClawConfig,
);
const logHooksInfoMock = vi.fn();
const logHooksWarnMock = vi.fn();

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: enqueueSystemEventMock,
}));
vi.mock("../../infra/heartbeat-wake.js", () => ({
  requestHeartbeat: requestHeartbeatMock,
}));
vi.mock("../../auto-reply/reply/session-event-handoff.js", () => ({
  captureSessionEventTargetForHost: captureSessionEventTargetMock,
  enqueueSessionEventForHost: enqueueSessionEventMock,
}));
vi.mock("../../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: runCronIsolatedAgentTurnMock,
}));
vi.mock("../../infra/outbound/message-account-selection.js", () => ({
  validateExplicitMessageAccountSelection: ({ accountId }: { accountId?: unknown }) => accountId,
}));
vi.mock("../../infra/outbound/channel-resolution.js", () => ({
  resolveOutboundChannelPlugin: () => ({ id: "telegram" }),
}));
vi.mock("../../channels/plugins/helpers.js", () => ({
  resolveChannelDefaultAccountId: () => "default",
}));
vi.mock("../../config/sessions.js", () => ({
  resolveMainSessionKeyFromConfig: () => "main-session",
  resolveMainSessionKey: (cfg?: { session?: { mainKey?: string; scope?: string } }) =>
    cfg?.session?.scope === "global" ? "global" : `agent:main:${cfg?.session?.mainKey ?? "main"}`,
  resolveAgentMainSessionKey: (params: {
    cfg?: { session?: { mainKey?: string } };
    agentId: string;
  }) => `agent:${params.agentId}:${params.cfg?.session?.mainKey ?? "main"}`,
}));
vi.mock("../../config/io.js", () => ({
  getRuntimeConfig: loadConfigMock,
}));

let capturedDispatchAgentHook: ((payload: unknown) => unknown) | undefined;

vi.mock("./hooks-request-handler.js", () => ({
  createHooksRequestHandler: (opts: { dispatchAgentHook?: (payload: unknown) => unknown }) => {
    capturedDispatchAgentHook = opts.dispatchAgentHook;
    return vi.fn();
  },
}));

const { createGatewayHooksRequestHandler } = await import("./hooks.js");
const { registerGuestTurnCompletionHandler } = await import("../../infra/guest-turn-completion.js");

const ATTESTATION = `fsa:job-1:${"A".repeat(43)}`;
const SHADOW_TEXT = "SHADOW_RUN_TEXT_7f3a";

function dispatchAgentHook(payload: Record<string, unknown>) {
  if (!capturedDispatchAgentHook) {
    throw new Error("dispatchAgentHook missing");
  }
  return capturedDispatchAgentHook(payload);
}

type ShadowRunCase = {
  sessionMode?: "isolated" | "persistent";
  sessionKey?: string;
};

function shadowPayload(extra: ShadowRunCase = {}) {
  return {
    message: "shadow turn",
    name: "Shadow",
    agentId: "cellect-fi-user",
    effectiveAgentId: "cellect-fi-user",
    wakeMode: "now" as const,
    sessionKey: "hook:fi-shadow:thread",
    sessionMode: "isolated" as const,
    sourcePath: "/hooks/agent",
    deliver: false,
    channel: "last" as const,
    delivery: { mode: "none" as const },
    requesterAttestation: ATTESTATION,
    ...extra,
  };
}

function loggedText(): string {
  return JSON.stringify([...logHooksInfoMock.mock.calls, ...logHooksWarnMock.mock.calls]);
}

describe("shadow hook terminals", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.clearAllMocks();
    capturedDispatchAgentHook = undefined;
    createGatewayHooksRequestHandler({
      scheduler: createTestGatewayScheduler("fake-timers"),
      deps: {} as never,
      getHooksConfig: () => null,
      getClientIpConfig: () => ({ trustedProxies: undefined, allowRealIpFallback: false }),
      bindHost: "127.0.0.1",
      port: 18789,
      logHooks: {
        warn: logHooksWarnMock,
        debug: vi.fn(),
        info: logHooksInfoMock,
        error: vi.fn(),
      } as never,
    });
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
    vi.restoreAllMocks();
  });

  it.each<[string, ShadowRunCase]>([
    ["isolated", { sessionMode: "isolated" }],
    ["persistent", { sessionMode: "persistent" }],
    ["agent-qualified", { sessionKey: "agent:cellect-fi-user:hook:fi-shadow:thread" }],
  ])("does not enqueue a failed %s shadow run", async (_mode, extra) => {
    runCronIsolatedAgentTurnMock.mockResolvedValue({
      status: "error",
      error: SHADOW_TEXT,
      summary: SHADOW_TEXT,
      diagnostics: { summary: SHADOW_TEXT },
    });

    const result = await dispatchAgentHook(shadowPayload(extra));

    expect(result).toMatchObject({ ok: false });
    expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: extra.sessionKey ?? "hook:fi-shadow:thread",
        job: expect.objectContaining({
          sessionTarget:
            extra.sessionMode === "persistent"
              ? `session:${extra.sessionKey ?? "hook:fi-shadow:thread"}`
              : "isolated",
        }),
      }),
    );
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
    expect(loggedText()).not.toContain(SHADOW_TEXT);
    expect(logHooksWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("status=error"),
      expect.objectContaining({ status: "error" }),
    );
    // The log sanitizer drops an undefined summary, so the field is absent.
    expect(logHooksWarnMock.mock.calls[0]?.[1]).not.toHaveProperty("summary");
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("does not enqueue an ok shadow run whose summary is run text", async () => {
    runCronIsolatedAgentTurnMock.mockResolvedValue({
      status: "ok",
      summary: SHADOW_TEXT,
      delivered: false,
    });

    const result = await dispatchAgentHook(shadowPayload({ sessionMode: "persistent" }));

    expect(result).toMatchObject({ ok: true });
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
    expect(loggedText()).not.toContain(SHADOW_TEXT);
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("does not enqueue the message of a thrown shadow run", async () => {
    runCronIsolatedAgentTurnMock.mockRejectedValue(new Error(SHADOW_TEXT));

    const result = await dispatchAgentHook(shadowPayload());

    expect(result).toMatchObject({ ok: false });
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
    expect(loggedText()).not.toContain(SHADOW_TEXT);
    expect(logHooksWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("status=error"),
      expect.objectContaining({ status: "error" }),
    );
    expect(logHooksWarnMock.mock.calls[0]?.[1]).not.toHaveProperty("summary");
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("still enqueues an ordinary hook failure", async () => {
    runCronIsolatedAgentTurnMock.mockResolvedValue({
      status: "error",
      error: "ordinary hook failed",
    });

    await dispatchAgentHook({
      ...shadowPayload({ sessionKey: "hook:fi-mail:thread" }),
      name: "Mail",
      agentId: "main",
      effectiveAgentId: "main",
      requesterAttestation: undefined,
    });

    await vi.waitFor(() =>
      expect(enqueueSessionEventMock).toHaveBeenCalledWith(
        "Hook Mail (error): ordinary hook failed",
        expect.objectContaining({
          agentId: "main",
          sessionKey: "agent:main:main",
          source: "hook",
          createIfMissing: true,
        }),
      ),
    );
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  describe("guest conversation turns", () => {
    const GUEST_SESSION = `hook:fi-guest:${"a".repeat(40)}`;
    const GUEST_ATTESTATION = `fga:gt_1:${"C".repeat(43)}`;
    const guestPayload = () =>
      ({
        ...shadowPayload({ sessionKey: GUEST_SESSION, sessionMode: "persistent" }),
        requesterEnvironment: "dev",
      }) as Record<string, unknown>;

    it("reports a finished guest run's text and never announces it", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const release = registerGuestTurnCompletionHandler(handler);
      runCronIsolatedAgentTurnMock.mockResolvedValue({ status: "ok", outputText: "the reply" });

      const result = await dispatchAgentHook({
        ...guestPayload(),
        agentId: "cellect-fi-guest",
        effectiveAgentId: "cellect-fi-guest",
        requesterAttestation: GUEST_ATTESTATION,
      });

      expect(result).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: GUEST_SESSION,
          attestation: GUEST_ATTESTATION,
          environment: "dev",
          status: "ok",
          outputText: "the reply",
        }),
      );
      expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          hookRequesterAttestation: GUEST_ATTESTATION,
          hookRequesterEnvironment: "dev",
        }),
      );
      expect(enqueueSessionEventMock).not.toHaveBeenCalled();
      expect(enqueueSystemEventMock).not.toHaveBeenCalled();
      release();
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    });

    it("contains a failing report and refuses a shadow receipt on a guest session", async () => {
      const release = registerGuestTurnCompletionHandler(vi.fn().mockRejectedValue(new Error("x")));
      runCronIsolatedAgentTurnMock.mockResolvedValue({ status: "ok", outputText: "the reply" });
      await dispatchAgentHook({ ...guestPayload(), requesterAttestation: GUEST_ATTESTATION });
      await vi.waitFor(() =>
        expect(logHooksWarnMock).toHaveBeenCalledWith(
          "guest turn report failed",
          expect.anything(),
        ),
      );
      runCronIsolatedAgentTurnMock.mockClear();
      const refused = await dispatchAgentHook({
        ...guestPayload(),
        requesterAttestation: ATTESTATION,
      });
      expect(refused).toMatchObject({ ok: false });
      const unnamed = await dispatchAgentHook({
        ...guestPayload(),
        requesterAttestation: GUEST_ATTESTATION,
        requesterEnvironment: undefined,
      });
      expect(unnamed).toMatchObject({ ok: false });
      expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalled();
      release();
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    });
  });
});
