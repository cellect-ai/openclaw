import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";

const enqueueSystemEventMock = vi.fn();
const requestHeartbeatMock = vi.fn();
const runCronIsolatedAgentTurnMock = vi.fn();
const loadConfigMock = vi.fn((): OpenClawConfig => ({ agents: { entries: { main: {} } } }));
const logHooksInfoMock = vi.fn();
const logHooksWarnMock = vi.fn();

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: enqueueSystemEventMock,
}));
vi.mock("../../infra/heartbeat-wake.js", () => ({
  requestHeartbeat: requestHeartbeatMock,
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
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
    expect(loggedText()).not.toContain(SHADOW_TEXT);
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("does not enqueue the message of a thrown shadow run", async () => {
    runCronIsolatedAgentTurnMock.mockRejectedValue(new Error(SHADOW_TEXT));

    const result = await dispatchAgentHook(shadowPayload());

    expect(result).toMatchObject({ ok: false });
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

    expect(enqueueSystemEventMock).toHaveBeenCalledWith("Hook Mail (error): ordinary hook failed", {
      sessionKey: "agent:main:main",
    });
    expect(requestHeartbeatMock).toHaveBeenCalled();
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });
});
