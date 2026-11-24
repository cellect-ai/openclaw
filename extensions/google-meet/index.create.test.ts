import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { Command } from "commander";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as gatewayRuntime from "openclaw/plugin-sdk/gateway-runtime";
import {
  createLocalMeetingRealtimeAudioTransport,
  createMeetingRealtimeEngineBindings,
  startMeetingRealtimeEngine,
} from "openclaw/plugin-sdk/meeting-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { createRequireRecord, useMeetingTestState } from "openclaw/plugin-sdk/test-fixtures";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { registerGoogleMeetCli } from "./src/cli.js";
import { resolveGoogleMeetConfig } from "./src/config.js";
import { meetRuntime, testBridgeProcess } from "./src/test-support/fixtures.test-helpers.js";
import {
  captureStdout,
  createGoogleMeetToolGatewayForTest,
  invokeGoogleMeetGatewayMethodForTest,
  noopLogger,
  setupGoogleMeetPlugin,
} from "./src/test-support/plugin-harness.js";
import { createTestMeetVoiceProvider } from "./src/test-support/voice-provider.test-support.js";
import { GOOGLE_MEET_PLATFORM_ADAPTER } from "./src/transports/google-meet-platform-adapter.js";

function mockCallArg(mock: { mock: { calls: unknown[][] } }, argIndex: number, callIndex = 0) {
  return mockCall(mock, callIndex)[argIndex];
}

function mockCall(mock: { mock: { calls: unknown[][] } }, callIndex = 0): unknown[] {
  const call = mock.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`Expected mock call at index ${callIndex}`);
  }
  return call;
}

function createMockSessionRuntime(sessionStore: Record<string, unknown>) {
  const sessionRoot = createIsolatedTestDir("openclaw-google-meet-session-");
  return {
    resolveStorePath: vi.fn(() => path.join(sessionRoot, "sessions.json")),
    loadSessionStore: vi.fn(() => sessionStore),
    saveSessionStore: vi.fn(async () => {}),
    updateSessionStore: vi.fn(async (_storePath, mutator: (store: never) => unknown) =>
      mutator(sessionStore as never),
    ),
    getSessionEntry: vi.fn(
      ({ sessionKey }: { sessionKey: string }) => sessionStore[sessionKey] as MockSessionEntry,
    ),
    patchSessionEntry: vi.fn(
      async ({
        sessionKey,
        fallbackEntry,
        update,
      }: {
        sessionKey: string;
        fallbackEntry: MockSessionEntry;
        update: (entry: MockSessionEntry) => Promise<MockSessionEntry> | MockSessionEntry;
      }) => {
        const current = (sessionStore[sessionKey] as MockSessionEntry | undefined) ?? fallbackEntry;
        const patch = await update(current);
        const next = { ...current, ...patch };
        sessionStore[sessionKey] = next;
        return next;
      },
    ),
    resolveSessionFilePath: vi.fn(() => path.join(sessionRoot, "session.json")),
  };
}

type TestLocalRealtimeEngineParams = Omit<
  Parameters<typeof startMeetingRealtimeEngine>[0],
  "config" | "consultAgent" | "handleToolCall" | "platform" | "tools" | "transport"
> & {
  config: ReturnType<typeof resolveGoogleMeetConfig>;
  spawn?: Parameters<typeof createLocalMeetingRealtimeAudioTransport>[0]["spawn"];
};
type MockSessionEntry = { sessionId: string; updatedAt: number; [key: string]: unknown };

async function startTestLocalRealtimeAudioBridge(params: TestLocalRealtimeEngineParams) {
  const { spawn, ...engineParams } = params;
  const transport = createLocalMeetingRealtimeAudioTransport({
    inputCommand: ["capture-meet"],
    outputCommand: ["play-meet"],
    bargeInInputCommand: params.config.chrome.bargeInInputCommand,
    bargeInRmsThreshold: params.config.chrome.bargeInRmsThreshold,
    bargeInPeakThreshold: params.config.chrome.bargeInPeakThreshold,
    bargeInCooldownMs: params.config.chrome.bargeInCooldownMs,
    logger: params.logger,
    logScope: "[google-meet]",
    spawn,
  });
  return await startMeetingRealtimeEngine({
    ...engineParams,
    ...createMeetingRealtimeEngineBindings({
      platform: GOOGLE_MEET_PLATFORM_ADAPTER,
      ...engineParams,
    }),
    transport,
  });
}

type GoogleMeetJoinResult = Awaited<ReturnType<ReturnType<typeof meetRuntime>["join"]>>;

let meetingTestState: ReturnType<typeof useMeetingTestState>;

vi.mock("./src/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./src/runtime.js")>();
  return {
    ...actual,
    GoogleMeetRuntime: class extends actual.GoogleMeetRuntime {
      constructor(...args: ConstructorParameters<typeof actual.GoogleMeetRuntime>) {
        super(...args);
        meetingTestState.track(this, {
          readWarnings: () => vi.mocked(args[0].logger.warn).mock.calls,
        });
      }
    },
  };
});

const testTempDirs = new Set<string>();

function createIsolatedTestDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  testTempDirs.add(dir);
  return dir;
}

const voiceCallMocks = vi.hoisted(() => ({
  joinMeetViaVoiceCallGateway: vi.fn(async () => ({
    callId: "call-1",
    dtmfSent: true,
    introSent: true,
  })),
  endMeetingVoiceCallGatewayCall: vi.fn(async () => {}),
  getMeetingVoiceCallGatewayCall: vi.fn(
    async (): Promise<{
      found: boolean;
      call?: { callId: string; state?: string; endedAt?: number; endReason?: string };
    }> => ({
      found: true,
      call: { callId: "call-1" },
    }),
  ),
  isMeetingVoiceCallMissingError: vi.fn((error: unknown) =>
    String(error).includes("Call not found"),
  ),
  speakMeetingViaVoiceCallGateway: vi.fn(async () => {}),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: vi.fn(async (params: { url: string; init?: RequestInit }) => ({
    response: await fetch(params.url, params.init),
    release: vi.fn(async () => {}),
  })),
}));

vi.mock("./src/voice-call-gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/voice-call-gateway.js")>()),
  joinMeetViaVoiceCallGateway: voiceCallMocks.joinMeetViaVoiceCallGateway,
}));

vi.mock("openclaw/plugin-sdk/meeting-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/meeting-runtime")>();
  return {
    ...actual,
    endMeetingVoiceCallGatewayCall: voiceCallMocks.endMeetingVoiceCallGatewayCall,
    getMeetingVoiceCallGatewayCall: voiceCallMocks.getMeetingVoiceCallGatewayCall,
    isMeetingVoiceCallMissingError: voiceCallMocks.isMeetingVoiceCallMissingError,
    speakMeetingViaVoiceCallGateway: voiceCallMocks.speakMeetingViaVoiceCallGateway,
  };
});

let localBrowserGatewayRequestHandler: NonNullable<
  Parameters<typeof setupGoogleMeetPlugin>[2]
>["gatewayRequestHandler"];

function setup(
  config?: Parameters<typeof setupGoogleMeetPlugin>[1],
  options?: Parameters<typeof setupGoogleMeetPlugin>[2],
) {
  const harness = setupGoogleMeetPlugin(plugin, config, {
    ...options,
    ...(localBrowserGatewayRequestHandler
      ? {
          gatewayAvailable: true,
          gatewayRequestHandler: localBrowserGatewayRequestHandler,
        }
      : {}),
  });
  vi.spyOn(gatewayRuntime, "callGatewayFromCli").mockImplementation(
    createGoogleMeetToolGatewayForTest(harness.methods),
  );
  return harness;
}

const requireRecord = createRequireRecord("record", "expected-label-object-capitalized");

function browserProxyPayload(result: unknown) {
  return { payload: { result } };
}

function setupCreate(config?: Parameters<typeof setup>[0], options?: Parameters<typeof setup>[1]) {
  return setup(
    { defaultTransport: "chrome-node", chromeNode: { node: "parallels-macos" }, ...config },
    options,
  );
}

type BrowserProxyBody = {
  fn?: string;
  targetId?: string;
  url?: string;
};

type BrowserProxyTab = {
  targetId: string;
  title?: string;
  url?: string;
};

function browserCreateResult(meetingUri: string) {
  return { meetingUri, browserUrl: meetingUri, browserTitle: "Meet" };
}

function createBrowserProxyHandler(options: {
  act: (body: BrowserProxyBody) => unknown;
  handleChromeStart?: boolean;
  navigateTo?: BrowserProxyTab;
  openedTargetId?: string | ((url: string | undefined) => string);
  openedTitle?: string;
  tabs?: BrowserProxyTab[];
}) {
  return async (params: { command: string; params?: unknown }) => {
    if (params.command === "googlemeet.chrome" && options.handleChromeStart) {
      return { payload: { launched: true } };
    }
    if (params.command !== "browser.proxy") {
      throw new Error(`unexpected node command ${params.command}`);
    }
    const proxy = params.params as { path?: string; body?: BrowserProxyBody };
    switch (proxy.path) {
      case "/tabs":
        return browserProxyPayload({ tabs: options.tabs ?? [] });
      case "/tabs/open": {
        const targetId =
          typeof options.openedTargetId === "function"
            ? options.openedTargetId(proxy.body?.url)
            : (options.openedTargetId ?? "tab-1");
        return browserProxyPayload({
          targetId,
          title: options.openedTitle ?? "Meet",
          url: proxy.body?.url,
        });
      }
      case "/tabs/focus":
      case "/permissions/grant":
        return browserProxyPayload({ ok: true });
      case "/navigate":
        if (options.navigateTo) {
          return browserProxyPayload(options.navigateTo);
        }
        break;
      case "/act":
        return browserProxyPayload({
          ok: true,
          targetId: proxy.body?.targetId,
          result: await options.act(proxy.body ?? {}),
        });
      case undefined:
        break;
    }
    throw new Error(`unexpected browser proxy path ${proxy.path}`);
  };
}

function expectBrowserProxyCall(
  nodesInvoke: ReturnType<typeof setup>["nodesInvoke"],
  proxyPath: string,
  body: BrowserProxyBody,
) {
  expect(nodesInvoke).toHaveBeenCalledWith(
    expect.objectContaining({
      command: "browser.proxy",
      params: expect.objectContaining({ path: proxyPath, body: expect.objectContaining(body) }),
    }),
  );
}

describe("google-meet plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const mock of Object.values(voiceCallMocks)) {
      mock.mockReset();
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    localBrowserGatewayRequestHandler = undefined;
    vi.restoreAllMocks();
    for (const dir of testTempDirs) {
      rmSync(dir, { force: true, recursive: true });
    }
    testTempDirs.clear();
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
    vi.doUnmock("openclaw/plugin-sdk/meeting-runtime");
    vi.doUnmock("./src/voice-call-gateway.js");
    vi.resetModules();
  });

  meetingTestState = useMeetingTestState(createOpenClawTestState);

  describe("google-meet create flow", () => {
    it("CLI create can configure API-created space access", async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url.includes("oauth2.googleapis.com")) {
          return new Response(
            JSON.stringify({
              access_token: "new-access-token",
              expires_in: 3600,
              token_type: "Bearer",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            name: "spaces/new-space",
            meetingCode: "new-abcd-xyz",
            meetingUri: "https://meet.google.com/new-abcd-xyz",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      const program = new Command();
      const stdout = captureStdout();
      const ensureRuntime = vi.fn(async () => {
        throw new Error("URL-only creation must not start the runtime");
      });
      registerGoogleMeetCli({
        program,
        config: resolveGoogleMeetConfig({
          oauth: { clientId: "client-id", refreshToken: "refresh-token" },
        }),
        ensureRuntime,
      });

      try {
        await program.parseAsync(
          [
            "googlemeet",
            "create",
            "--no-join",
            "--access-type",
            "OPEN",
            "--entry-point-access",
            "ALL",
          ],
          { from: "user" },
        );
        expect(ensureRuntime).not.toHaveBeenCalled();
        expect(stdout.output()).toContain("meeting uri: https://meet.google.com/new-abcd-xyz");
        expect(stdout.output()).toContain("space: spaces/new-space");
        expect(stdout.output()).toContain("meeting code: new-abcd-xyz");
        expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
          expect.objectContaining({
            url: "https://meet.googleapis.com/v2/spaces",
            init: {
              method: "POST",
              headers: {
                Authorization: "Bearer new-access-token",
                Accept: "application/json",
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ config: { accessType: "OPEN", entryPointAccess: "ALL" } }),
            },
            policy: { allowedHostnames: ["meet.googleapis.com"] },
          }),
        );
      } finally {
        stdout.restore();
      }
    });

    it("rejects access policy flags when tool create would use browser fallback", async () => {
      const { methods, nodesInvoke } = setupCreate(
        {},
        {
          nodesInvokeHandler: async () => {
            throw new Error("browser fallback should not run");
          },
        },
      );

      await expect(
        invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.create", {
          join: false,
          accessType: "OPEN",
        }),
      ).rejects.toThrow("access policy options require OAuth/API room creation");
      expect(nodesInvoke).not.toHaveBeenCalled();
    });

    it("creates and joins a Meet through the create tool action by default", async () => {
      const { tools, nodesInvoke } = setupCreate(
        { defaultMode: "transcribe" },
        {
          nodesInvokeHandler: createBrowserProxyHandler({
            handleChromeStart: true,
            openedTargetId: (url) =>
              url === "https://meet.google.com/new?hl=en" ? "create-tab" : "join-tab",
            act: (body) =>
              body.fn?.includes("meetUrlPattern")
                ? browserCreateResult("https://meet.google.com/new-abcd-xyz")
                : JSON.stringify({
                    inCall: true,
                    micMuted: false,
                    title: "Meet call",
                    url: "https://meet.google.com/new-abcd-xyz",
                  }),
          }),
        },
      );
      const tool = tools[0] as {
        execute: (
          id: string,
          params: unknown,
        ) => Promise<{
          details: {
            source?: string;
            joined?: boolean;
            meetingUri?: string;
            join?: { session: { url: string } };
          };
        }>;
      };

      const result = await tool.execute("id", { action: "create" });

      expect(result.details.source).toBe("browser");
      expect(result.details.joined).toBe(true);
      expect(result.details.meetingUri).toBe("https://meet.google.com/new-abcd-xyz");
      expect(result.details.join?.session.url).toBe("https://meet.google.com/new-abcd-xyz");
      expectBrowserProxyCall(nodesInvoke, "/tabs/open", {
        url: "https://meet.google.com/new?hl=en",
      });
      expect(nodesInvoke).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "googlemeet.chrome",
          params: expect.objectContaining({
            action: "start",
            url: "https://meet.google.com/new-abcd-xyz",
            launch: false,
          }),
        }),
      );
    });

    it("returns structured manual action from the create tool action", async () => {
      const { tools } = setupCreate(
        {},
        {
          nodesInvokeHandler: createBrowserProxyHandler({
            openedTargetId: "permission-tab",
            act: () => ({
              manualAction: {
                reason: "meet-permission-required",
                message:
                  "Allow microphone/camera permissions for Meet in the OpenClaw browser profile, then retry meeting creation.",
              },
              browserUrl: "https://meet.google.com/new",
              browserTitle: "Meet",
              notes: ["Permission prompt detected."],
            }),
          }),
        },
      );
      const tool = tools[0] as {
        execute: (id: string, params: unknown) => Promise<{ details: Record<string, unknown> }>;
      };

      const result = await tool.execute("id", { action: "create" });

      expect(result.details.source).toBe("browser");
      expect(result.details.error).toBe(
        "meet-permission-required: Allow microphone/camera permissions for Meet in the OpenClaw browser profile, then retry meeting creation.",
      );
      expect(result.details.manualAction).toEqual({
        reason: "meet-permission-required",
        message:
          "Allow microphone/camera permissions for Meet in the OpenClaw browser profile, then retry meeting creation.",
      });
      const browser = requireRecord(result.details.browser, "browser details");
      expect(browser.nodeId).toBe("node-1");
      expect(browser.targetId).toBe("permission-tab");
      expect(browser.browserUrl).toBe("https://meet.google.com/new");
      expect(browser.browserTitle).toBe("Meet");
      expect(browser.notes).toEqual(["Permission prompt detected."]);
    });

    it("reuses an existing browser create tab instead of opening duplicates", async () => {
      const { methods, nodesInvoke } = setupCreate(
        {},
        {
          nodesInvokeHandler: createBrowserProxyHandler({
            tabs: [
              {
                targetId: "existing-create-tab",
                title: "Meet",
                url: "https://meet.google.com/new",
              },
            ],
            navigateTo: {
              targetId: "navigated-create-tab",
              url: "https://meet.google.com/new?hl=en",
            },
            act: () => browserCreateResult("https://meet.google.com/reu-sedx-tab"),
          }),
        },
      );
      const payload = requireRecord(
        await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.create", { join: false }),
        "response payload",
      );
      expect(payload.source).toBe("browser");
      expect(payload.meetingUri).toBe("https://meet.google.com/reu-sedx-tab");
      expect(payload.joined).toBe(false);
      const browser = requireRecord(payload.browser, "browser payload");
      expect(browser.nodeId).toBe("node-1");
      expect(browser.targetId).toBe("navigated-create-tab");
      expectBrowserProxyCall(nodesInvoke, "/tabs/focus", {
        targetId: "existing-create-tab",
      });
      expectBrowserProxyCall(nodesInvoke, "/navigate", {
        targetId: "existing-create-tab",
        url: "https://meet.google.com/new?hl=en",
      });
      expectBrowserProxyCall(nodesInvoke, "/act", {
        targetId: "navigated-create-tab",
      });
      expect(nodesInvoke).not.toHaveBeenCalledWith(
        expect.objectContaining({
          command: "browser.proxy",
          params: expect.objectContaining({ path: "/tabs/open" }),
        }),
      );
    });
  });

  it("stops the Chrome realtime audio bridge when child stdout errors", async () => {
    const providerClosed = createDeferred<void>();
    const { bridge, provider, requireRequest } = createTestMeetVoiceProvider({
      handleBargeIn: vi.fn(),
      triggerGreeting: vi.fn(),
    });
    bridge.close.mockReturnValue(providerClosed.promise);
    const inputStdout = new PassThrough();
    const outputProcess = testBridgeProcess({
      stdin: new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
      stdout: null,
    });
    const inputProcess = testBridgeProcess({ stdin: null, stdout: inputStdout });
    const spawnMock = vi.fn().mockReturnValueOnce(outputProcess).mockReturnValueOnce(inputProcess);

    const handle = await startTestLocalRealtimeAudioBridge({
      config: resolveGoogleMeetConfig({
        realtime: { strategy: "bidi", provider: "openai", model: "gpt-realtime" },
      }),
      fullConfig: { models: { providers: {} } } as never,
      runtime: {} as never,
      meetingSessionId: "meet-1",
      logger: noopLogger,
      providers: [provider],
      spawn: spawnMock,
    });

    try {
      expect(() => inputStdout.emit("error", new Error("EPIPE"))).not.toThrow();
      expect(noopLogger.warn).toHaveBeenCalledWith(
        "[google-meet] audio input command stdout failed: EPIPE",
      );
      expect(inputProcess.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
      expect(outputProcess.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
      expect(handle.getHealth().bridgeClosed).toBe(false);
      inputStdout.emit("data", Buffer.from([1, 2]));
      expect(bridge.sendAudio).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(bridge.close).toHaveBeenCalledOnce();
      requireRequest().onTranscript?.("assistant", "Final received words.", true);
      expect(handle.getHealth().lastRealtimeTranscriptText).toBe("Final received words.");
      expect(handle.getHealth().bridgeClosed).toBe(false);
    } finally {
      providerClosed.resolve();
      await handle.stop();
    }
    expect(handle.getHealth().bridgeClosed).toBe(true);
  });

  it("pipes Chrome command-pair audio through the realtime provider", async () => {
    const { bridge, provider, requireRequest, sendAudio } = createTestMeetVoiceProvider({
      defaultModel: "gpt-realtime-2",
      supportsToolResultContinuation: true,
      handleBargeIn: vi.fn(),
      triggerGreeting: vi.fn(),
    });
    const inputStdout = new PassThrough();
    const outputStdinWrites: Buffer[] = [];
    const replacementOutputStdinWrites: Buffer[] = [];
    const outputStdin = new Writable({
      write(chunk, _encoding, done) {
        outputStdinWrites.push(Buffer.from(chunk));
        done();
      },
    });
    const replacementOutputStdin = new Writable({
      write(chunk, _encoding, done) {
        replacementOutputStdinWrites.push(Buffer.from(chunk));
        done();
      },
    });
    const inputProcess = testBridgeProcess({ stdout: inputStdout, stdin: null });
    const outputProcess = testBridgeProcess({ stdin: outputStdin, stdout: null });
    const replacementOutputProcess = testBridgeProcess({
      stdin: replacementOutputStdin,
      stdout: null,
    });
    const spawnMock = vi
      .fn()
      .mockReturnValueOnce(outputProcess)
      .mockReturnValueOnce(inputProcess)
      .mockReturnValueOnce(replacementOutputProcess);
    const fullConfig = { models: { providers: {} } } as never;
    const sessionStore: Record<string, unknown> = {};
    const runtime = {
      agent: {
        resolveAgentDir: vi.fn(() => "/tmp/agent"),
        resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
        ensureAgentWorkspace: vi.fn(async () => {}),
        session: createMockSessionRuntime(sessionStore),
        runEmbeddedAgent: vi.fn(async (_request: unknown) => ({
          payloads: [{ text: "Use the Portugal launch data." }],
          meta: {},
        })),
        resolveAgentTimeoutMs: vi.fn(() => 1000),
      },
    };

    const handle = await startTestLocalRealtimeAudioBridge({
      config: resolveGoogleMeetConfig({
        realtime: { strategy: "bidi", provider: "openai", model: "gpt-realtime", agentId: "jay" },
      }),
      fullConfig,
      runtime: runtime as never,
      meetingSessionId: "meet-1",
      logger: noopLogger,
      providers: [provider],
      spawn: spawnMock,
    });
    const callbacks = requireRequest();

    expect(noopLogger.info).toHaveBeenCalledWith(
      "[google-meet] realtime voice bridge starting: strategy=bidi provider=openai model=gpt-realtime audioFormat=pcm16-24khz",
    );
    expect(callbacks.cfg).toBe(fullConfig);
    inputStdout.write(Buffer.from([1, 2, 3]));
    callbacks.onAudio(Buffer.from([4, 5]));
    await vi.waitFor(() => {
      expect(outputStdinWrites).toEqual([Buffer.from([4, 5])]);
    });
    callbacks.onMark?.("mark-1");
    callbacks.onClearAudio();
    await vi.waitFor(() => {
      expect(outputProcess.kill).toHaveBeenCalledWith("SIGKILL");
    });
    callbacks.onReady?.();
    callbacks.onTranscript?.("assistant", "How can I help you?", true);
    callbacks.onTranscript?.("user", "Please summarize the launch.", true);
    callbacks.onEvent?.({ direction: "client", type: "response.create" });
    callbacks.onEvent?.({
      direction: "server",
      type: "response.done",
      detail: "status=completed",
    });
    callbacks.onAudio(Buffer.from([6, 7]));
    callbacks.onToolCall?.({
      itemId: "item-1",
      callId: "tool-call-1",
      name: "openclaw_agent_consult",
      args: { question: "What should I say about launch timing?" },
    });
    expect(bridge.submitToolResult).toHaveBeenCalled();
    const firstToolResultCall = mockCall(bridge.submitToolResult);
    expect(firstToolResultCall[0]).toBe("tool-call-1");
    expect(firstToolResultCall[2]).toStrictEqual({ willContinue: true });
    const progressPayload = requireRecord(firstToolResultCall[1], "tool progress payload");
    expect(progressPayload.status).toBe("working");
    expect(progressPayload.tool).toBe("openclaw_agent_consult");

    expect(spawnMock).toHaveBeenNthCalledWith(1, "play-meet", [], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    expect(spawnMock).toHaveBeenNthCalledWith(2, "capture-meet", [], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(sendAudio).toHaveBeenCalledWith(Buffer.from([1, 2, 3]));
    await vi.waitFor(() => {
      expect(replacementOutputStdinWrites).toEqual([Buffer.from([6, 7])]);
    });
    outputProcess.emit("error", new Error("stale output process failed after clear"));
    outputStdin.emit("error", new Error("stale output pipe closed after clear"));
    outputProcess.stderr.emit("error", new Error("stale output stderr closed after clear"));
    expect(bridge.close).not.toHaveBeenCalled();
    expect(bridge.acknowledgeMark).toHaveBeenCalled();
    expect(bridge.triggerGreeting).not.toHaveBeenCalled();
    handle.speak("Say exactly: hello from the meeting.");
    expect(bridge.triggerGreeting).toHaveBeenLastCalledWith("Say exactly: hello from the meeting.");
    const health = handle.getHealth();
    expect(health.providerConnected).toBe(true);
    expect(health.realtimeReady).toBe(true);
    expect(health.audioInputActive).toBe(true);
    expect(health.audioOutputActive).toBe(true);
    expect(health.lastInputBytes).toBe(3);
    expect(health.lastOutputBytes).toBe(4);
    expect(health.realtimeTranscriptLines).toBe(2);
    expect(health.lastRealtimeTranscriptRole).toBe("user");
    expect(health.lastRealtimeTranscriptText).toBe("Please summarize the launch.");
    expect(health.lastRealtimeEventType).toBe("server:response.done");
    expect(health.lastRealtimeEventDetail).toBe("status=completed");
    expect(health.clearCount).toBe(1);
    expect(health.recentRealtimeTranscript).toHaveLength(2);
    expect(health.recentRealtimeTranscript?.[0]?.role).toBe("assistant");
    expect(health.recentRealtimeTranscript?.[0]?.text).toBe("How can I help you?");
    expect(health.recentRealtimeTranscript?.[1]?.role).toBe("user");
    expect(health.recentRealtimeTranscript?.[1]?.text).toBe("Please summarize the launch.");
    expect(health.recentRealtimeEvents).toHaveLength(2);
    expect(health.recentRealtimeEvents?.[0]?.direction).toBe("client");
    expect(health.recentRealtimeEvents?.[0]?.type).toBe("response.create");
    expect(health.recentRealtimeEvents?.[1]?.direction).toBe("server");
    expect(health.recentRealtimeEvents?.[1]?.type).toBe("response.done");
    expect(health.recentRealtimeEvents?.[1]?.detail).toBe("status=completed");
    expect(callbacks.audioFormat).toStrictEqual({
      encoding: "pcm16",
      sampleRateHz: 24000,
      channels: 1,
    });
    expect(callbacks.autoRespondToAudio).toBe(true);
    expect(callbacks.tools?.map((tool) => tool.name)).toContain("openclaw_agent_consult");
    await vi.waitFor(() => {
      expect(bridge.submitToolResult).toHaveBeenLastCalledWith(
        "tool-call-1",
        {
          text: "Use the Portugal launch data.",
        },
        undefined,
      );
    });
    const talkEventTypes = handle.getHealth().recentTalkEvents?.map((event) => event.type) ?? [];
    for (const type of [
      "session.started",
      "session.ready",
      "input.audio.delta",
      "output.audio.delta",
      "output.audio.done",
      "transcript.done",
      "output.text.done",
      "tool.call",
      "tool.progress",
      "tool.result",
      "turn.ended",
    ]) {
      expect(talkEventTypes).toContain(type);
    }
    expect(runtime.agent.runEmbeddedAgent).toHaveBeenCalledTimes(1);
    const agentRequest = requireRecord(
      mockCallArg(runtime.agent.runEmbeddedAgent, 0),
      "embedded agent request",
    );
    expect(agentRequest.messageProvider).toBe("google-meet");
    expect(agentRequest.agentId).toBe("jay");
    expect(agentRequest.spawnedBy).toBe("agent:jay:main");
    expect(agentRequest.sessionKey).toBe("agent:jay:subagent:google-meet:meet-1");
    expect(agentRequest.sandboxSessionKey).toBe("agent:jay:subagent:google-meet:meet-1");
    expect(agentRequest.thinkLevel).toBe("high");
    expect(agentRequest.toolsAllow).toStrictEqual([
      "read",
      "fi_user_api",
      "sessions_history",
      "sessions_search",
      "tavily_search",
      "tavily_extract",
      "web_search",
      "web_fetch",
      "x_search",
      "memory_search",
      "memory_get",
    ]);
    expect(sessionStore).toHaveProperty("agent:jay:subagent:google-meet:meet-1");

    await handle.stop();
    expect(bridge.close).toHaveBeenCalled();
    expect(inputProcess.kill).toHaveBeenCalledWith("SIGTERM");
    expect(replacementOutputProcess.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
