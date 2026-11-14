// Fan-out items admit in the background: a slow cold batch must never be
// admission-canceled, or nothing reaches the replay cache and every producer
// redelivery repeats the same cold burst (livelock). Direct hooks keep the
// bounded 15s admission contract.
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { resolveHooksConfig } from "../hooks.js";

const mocks = vi.hoisted(() => ({
  enqueueSystemEvent: vi.fn(),
  getRuntimeConfig: vi.fn<() => OpenClawConfig>(),
  requestHeartbeat: vi.fn(),
  runCronIsolatedAgentTurn: vi.fn(),
}));

vi.mock("../../config/io.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));
vi.mock("../../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: mocks.runCronIsolatedAgentTurn,
}));
vi.mock("../../infra/heartbeat-wake.js", () => ({
  requestHeartbeat: mocks.requestHeartbeat,
}));
vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: mocks.enqueueSystemEvent,
}));

const { createGatewayHooksRequestHandler } = await import("./hooks.js");

const config: OpenClawConfig = {
  agents: { entries: { main: {} } },
  hooks: {
    enabled: true,
    token: "hook-secret",
    presets: ["gmail"],
    defaultSessionKey: "hook:gmail:ingress",
    allowRequestSessionKey: true,
    allowedSessionKeyPrefixes: ["hook:gmail:"],
  },
};

function createHandler(admissionTimeoutMs: number) {
  const hooksConfig = resolveHooksConfig(config);
  if (!hooksConfig) {
    throw new Error("expected resolved hooks config");
  }
  return createGatewayHooksRequestHandler({
    scheduler: createTestGatewayScheduler("fake-timers"),
    deps: {} as never,
    getHooksConfig: () => hooksConfig,
    getClientIpConfig: () => ({}),
    bindHost: "127.0.0.1",
    port: 18789,
    logHooks: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } as never,
    agentStartAdmissionTimeoutMs: admissionTimeoutMs,
  });
}

async function post(
  handler: ReturnType<typeof createGatewayHooksRequestHandler>,
  path: string,
  payload: Record<string, unknown>,
) {
  const req = Object.assign(Readable.from([JSON.stringify(payload)]), {
    method: "POST",
    url: path,
    headers: {
      authorization: "Bearer hook-secret",
      "content-type": "application/json",
    },
    socket: { remoteAddress: "127.0.0.1" },
  }) as unknown as IncomingMessage;
  let responseBody = "";
  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn((chunk?: string) => {
      if (typeof chunk === "string") {
        responseBody = chunk;
      }
    }),
  } as unknown as ServerResponse;
  expect(await handler(req, res)).toBe(true);
  return { res, body: () => responseBody };
}

describe("hook background admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("attested silent HTTP hooks", () => {
    const reviewKey = `hook:fi-review:${"a".repeat(40)}`;
    const cases = [
      {
        purpose: "review",
        sessionKey: reviewKey,
        requesterAttestation: `pra:review-job:${"A".repeat(43)}`,
      },
      {
        purpose: "RFI",
        sessionKey: "hook:fi-rfi:rfi-job",
        requesterAttestation: `fsa:rfi-job:${"B".repeat(43)}`,
        requesterEnvironment: "prod",
      },
      {
        purpose: "CO",
        sessionKey: "hook:fi-co:co-job",
        requesterAttestation: `fcw:co-job:${"C".repeat(43)}`,
        requesterEnvironment: "prod",
      },
    ];
    beforeEach(() => {
      mocks.getRuntimeConfig.mockReturnValue({
        ...config,
        agents: { entries: { "cellect-fi-user": {} } },
        hooks: {
          ...config.hooks,
          presets: [],
          defaultSessionKey: reviewKey,
          allowedAgentIds: ["cellect-fi-user"],
          allowedSessionKeyPrefixes: ["hook:fi-review:", "hook:fi-rfi:", "hook:fi-co:"],
        },
      });
      mocks.runCronIsolatedAgentTurn.mockImplementation(
        async (params: { onExecutionStarted?: () => void }) => {
          params.onExecutionStarted?.();
          return { status: "ok" as const };
        },
      );
    });
    function attestedHandler() {
      const hooksConfig = resolveHooksConfig(mocks.getRuntimeConfig());
      if (!hooksConfig) {
        throw new Error("expected attested hook config");
      }
      return createGatewayHooksRequestHandler({
        scheduler: createTestGatewayScheduler("fake-timers"),
        deps: {} as never,
        getHooksConfig: () => hooksConfig,
        getClientIpConfig: () => ({}),
        bindHost: "127.0.0.1",
        port: 18789,
        logHooks: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } as never,
      });
    }
    function body(input: (typeof cases)[number]) {
      const { purpose: _purpose, ...scope } = input;
      return {
        message: "Run the enrolled review",
        agentId: "cellect-fi-user",
        sessionMode: "isolated",
        deliver: false,
        waitForCompletion: true,
        ...scope,
      };
    }
    it.each(cases)(
      "admits normalized silent $purpose hooks through the actual HTTP dispatch path",
      async (input) => {
        const response = await post(attestedHandler(), "/hooks/agent", body(input));
        expect(response.res.statusCode).toBe(200);
        expect(JSON.parse(response.body())).toMatchObject({
          ok: true,
          completion: { status: "ok" },
        });
        expect(mocks.runCronIsolatedAgentTurn).toHaveBeenCalledTimes(1);
        const params = mocks.runCronIsolatedAgentTurn.mock.calls[0][0];
        expect(params).toMatchObject({ hookRequesterAttestation: input.requesterAttestation });
        expect(params.hookRequesterEnvironment).toBe(input.requesterEnvironment);
        expect(params.job.delivery).toEqual({ mode: "none" });
        expect(JSON.stringify(params.job)).not.toContain(input.requesterAttestation);
        expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
      },
    );
    it.each(cases)(
      "still refuses raw channel:last on a silent $purpose HTTP hook",
      async (input) => {
        const response = await post(attestedHandler(), "/hooks/agent", {
          ...body(input),
          channel: "last",
        });
        expect(response.res.statusCode).toBe(400);
        expect(mocks.runCronIsolatedAgentTurn).not.toHaveBeenCalled();
      },
    );
    it.each([
      { ...cases[0], requesterAttestation: cases[1].requesterAttestation },
      { ...cases[1], requesterAttestation: cases[2].requesterAttestation },
      { ...cases[2], requesterAttestation: cases[0].requesterAttestation },
      { ...cases[1], requesterEnvironment: undefined },
      { ...cases[2], requesterEnvironment: "invalid" },
    ])(
      "refuses wrong-purpose or missing/invalid source environment before running ($purpose)",
      async (input) => {
        const response = await post(attestedHandler(), "/hooks/agent", body(input));
        expect(response.res.statusCode).toBe(400);
        expect(mocks.runCronIsolatedAgentTurn).not.toHaveBeenCalled();
      },
    );
  });

  it("admits slow fan-out items past the bounded deadline instead of canceling them", async () => {
    mocks.getRuntimeConfig.mockReturnValue(config);
    // Execution starts well after the 20ms bounded admission deadline,
    // mirroring cold concurrent workspace prep.
    mocks.runCronIsolatedAgentTurn.mockImplementation(
      async (params: { onExecutionStarted?: () => void; abortSignal?: AbortSignal }) => {
        await delay(60);
        expect(params.abortSignal?.aborted).toBe(false);
        params.onExecutionStarted?.();
        return { status: "ok" as const };
      },
    );
    const handler = createHandler(20);

    const response = await post(handler, "/hooks/gmail", {
      messages: [
        { id: "bg1", from: "a@example.com", subject: "One" },
        { id: "bg2", from: "b@example.com", subject: "Two" },
      ],
    });

    expect(response.res.statusCode).toBe(200);
    const body = JSON.parse(response.body()) as { runIds?: string[] };
    expect(body.runIds).toHaveLength(2);
    expect(mocks.runCronIsolatedAgentTurn).toHaveBeenCalledTimes(2);
  });

  it("announces a pre-execution fan-out failure once across producer redeliveries", async () => {
    mocks.getRuntimeConfig.mockReturnValue(config);
    mocks.runCronIsolatedAgentTurn.mockResolvedValue({
      status: "skipped" as const,
      error: "model provider unavailable",
      admissionDisposition: "rejected" as const,
    });
    const handler = createHandler(100);
    const redelivered = { messages: [{ id: "alert1", from: "a@example.com", subject: "Alert" }] };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await post(handler, "/hooks/gmail", redelivered);
      expect(response.res.statusCode).toBe(502);
    }
    await post(handler, "/hooks/gmail", {
      messages: [{ id: "alert2", from: "b@example.com", subject: "Other" }],
    });

    expect(mocks.runCronIsolatedAgentTurn).toHaveBeenCalledTimes(4);
    expect(mocks.enqueueSystemEvent.mock.calls.map(([text]) => text)).toEqual([
      "Hook Gmail (skipped): model provider unavailable",
      "Hook Gmail (skipped): model provider unavailable",
    ]);

    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60_000 + 1);
    try {
      expect((await post(handler, "/hooks/gmail", redelivered)).res.statusCode).toBe(502);
      expect(mocks.runCronIsolatedAgentTurn).toHaveBeenCalledTimes(5);
      expect(mocks.enqueueSystemEvent.mock.calls.map(([text]) => text)).toEqual([
        "Hook Gmail (skipped): model provider unavailable",
        "Hook Gmail (skipped): model provider unavailable",
        "Hook Gmail (skipped): model provider unavailable",
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  it("announces an execution failure after an earlier redelivery failed admission", async () => {
    mocks.getRuntimeConfig.mockReturnValue(config);
    mocks.runCronIsolatedAgentTurn
      .mockResolvedValueOnce({
        status: "skipped" as const,
        error: "model provider unavailable",
        admissionDisposition: "rejected" as const,
      })
      .mockImplementationOnce(async (params: { onExecutionStarted?: () => void }) => {
        params.onExecutionStarted?.();
        return { status: "error" as const, error: "execution failed" };
      });
    const handler = createHandler(100);
    const redelivered = { messages: [{ id: "alert3", from: "c@example.com", subject: "Alert" }] };

    expect((await post(handler, "/hooks/gmail", redelivered)).res.statusCode).toBe(502);
    expect((await post(handler, "/hooks/gmail", redelivered)).res.statusCode).toBe(200);

    await vi.waitFor(() =>
      expect(mocks.enqueueSystemEvent.mock.calls.map(([text]) => text)).toEqual([
        "Hook Gmail (skipped): model provider unavailable",
        "Hook Gmail (error): execution failed",
      ]),
    );
  });

  it("keeps the bounded admission cancel for direct agent hooks", async () => {
    mocks.getRuntimeConfig.mockReturnValue(config);
    let sawAbort = false;
    mocks.runCronIsolatedAgentTurn.mockImplementation(
      async (params: { onExecutionStarted?: () => void; abortSignal?: AbortSignal }) => {
        await delay(60);
        sawAbort = params.abortSignal?.aborted === true;
        if (!sawAbort) {
          params.onExecutionStarted?.();
        }
        return { status: "ok" as const };
      },
    );
    const handler = createHandler(20);

    const response = await post(handler, "/hooks/agent", { message: "Direct", name: "Bounded" });

    expect(response.res.statusCode).toBe(503);
    // The canceled run must not proceed after the 503.
    await delay(80);
    expect(sawAbort).toBe(true);
  });

  it.each([
    { deliverySuppressionReason: "empty", replyDisposition: "empty" },
    { deliverySuppressionReason: "silent", replyDisposition: "silent" },
    { deliverySuppressionReason: "heartbeat", replyDisposition: "empty" },
    { deliverySuppressionReason: "channel_transform", replyDisposition: "visible" },
  ] as const)(
    "returns the $deliverySuppressionReason terminal suppression reason to an explicit waiter",
    async ({ deliverySuppressionReason, replyDisposition }) => {
      mocks.getRuntimeConfig.mockReturnValue(config);
      mocks.runCronIsolatedAgentTurn.mockImplementationOnce(
        async (params: { onExecutionStarted?: () => void }) => {
          params.onExecutionStarted?.();
          return {
            status: "ok" as const,
            delivered: false,
            deliveryAttempted: true,
            deliverySuppressionReason,
            replyDisposition,
            outputText: "private output",
            summary: "private summary",
            sessionId: "private-session",
            sessionKey: "private-session-key",
          };
        },
      );
      const handler = createHandler(100);

      const response = await post(handler, "/hooks/agent", {
        message: "Direct",
        name: "Observed",
        waitForCompletion: true,
      });

      expect(response.res.statusCode).toBe(200);
      expect(JSON.parse(response.body())).toEqual({
        ok: true,
        runId: expect.any(String),
        completion: {
          status: "ok",
          replyDisposition,
          delivered: false,
          deliveryAttempted: true,
          deliverySuppressionReason,
        },
      });
    },
  );

  it("returns categorical delivery failure without private run data", async () => {
    mocks.getRuntimeConfig.mockReturnValue(config);
    const secret = "fake-secret-value-that-must-not-leak";
    mocks.runCronIsolatedAgentTurn.mockImplementationOnce(
      async (params: { onExecutionStarted?: () => void }) => {
        params.onExecutionStarted?.();
        return {
          status: "ok" as const,
          replyDisposition: "visible" as const,
          delivered: false,
          deliveryAttempted: true,
          deliveryError: `line\nAuthorization: Bearer ${secret}\n${"x".repeat(600)} tail`,
          outputText: "private output",
          summary: "private summary",
          sessionId: "private-session",
          sessionKey: "private-session-key",
        };
      },
    );
    const handler = createHandler(100);

    const response = await post(handler, "/hooks/agent", {
      message: "Direct",
      name: "Observed",
      waitForCompletion: true,
    });

    const body = JSON.parse(response.body()) as {
      completion: { deliveryError: string };
    };
    expect(response.res.statusCode).toBe(200);
    expect(body).toMatchObject({
      completion: {
        status: "ok",
        replyDisposition: "visible",
        delivered: false,
        deliveryAttempted: true,
        deliveryError: "delivery-failed",
      },
    });
    expect(JSON.stringify(body)).not.toMatch(
      /Authorization|fake-secret-value|private output|private summary|private-session|x{20}/,
    );
  });

  it("preserves an attempted delivery with unknown acknowledgment", async () => {
    mocks.getRuntimeConfig.mockReturnValue(config);
    mocks.runCronIsolatedAgentTurn.mockImplementationOnce(
      async (params: { onExecutionStarted?: () => void }) => {
        params.onExecutionStarted?.();
        return {
          status: "ok" as const,
          replyDisposition: "empty" as const,
          delivered: false,
          deliveryAttempted: true,
        };
      },
    );
    const handler = createHandler(100);

    const response = await post(handler, "/hooks/agent", {
      message: "Direct",
      name: "Observed",
      waitForCompletion: true,
    });

    expect(JSON.parse(response.body())).toEqual({
      ok: true,
      runId: expect.any(String),
      completion: {
        status: "ok",
        replyDisposition: "empty",
        delivered: false,
        deliveryAttempted: true,
      },
    });
  });

  it("settles an admitted waiter when the isolated runner throws", async () => {
    mocks.getRuntimeConfig.mockReturnValue(config);
    mocks.runCronIsolatedAgentTurn.mockImplementationOnce(
      async (params: { onExecutionStarted?: () => void }) => {
        params.onExecutionStarted?.();
        throw new Error("private execution diagnostic");
      },
    );
    const handler = createHandler(100);

    const response = await post(handler, "/hooks/agent", {
      message: "Direct",
      name: "Observed",
      waitForCompletion: true,
    });

    expect(response.res.statusCode).toBe(200);
    expect(JSON.parse(response.body())).toEqual({
      ok: true,
      runId: expect.any(String),
      completion: { status: "error", replyDisposition: "empty" },
    });
  });

  it.each([
    {
      name: "verified message-tool delivery",
      result: {
        status: "ok" as const,
        replyDisposition: "silent" as const,
        delivered: true,
        deliveryAttempted: true,
      },
    },
    {
      name: "silent model reply",
      result: {
        status: "ok" as const,
        replyDisposition: "silent" as const,
        delivered: false,
        deliveryAttempted: false,
      },
    },
    {
      name: "private visible model reply",
      result: {
        status: "ok" as const,
        replyDisposition: "visible" as const,
        delivered: false,
        deliveryAttempted: false,
        outputText: "private visible final",
      },
    },
  ])("returns bounded evidence for deliver:false + $name", async ({ result }) => {
    mocks.getRuntimeConfig.mockReturnValue(config);
    mocks.runCronIsolatedAgentTurn.mockImplementationOnce(
      async (params: { onExecutionStarted?: () => void }) => {
        params.onExecutionStarted?.();
        return result;
      },
    );
    const handler = createHandler(100);

    const response = await post(handler, "/hooks/agent", {
      message: "Direct",
      name: "Observed",
      deliver: false,
      waitForCompletion: true,
    });

    expect(response.res.statusCode).toBe(200);
    const body = JSON.parse(response.body()) as {
      completion: Record<string, unknown>;
    };
    expect(body.completion).toMatchObject({
      status: result.status,
      replyDisposition: result.replyDisposition,
      delivered: result.delivered,
      deliveryAttempted: result.deliveryAttempted,
    });
    expect(JSON.stringify(body)).not.toContain("private visible final");
  });
});
