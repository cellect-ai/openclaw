import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  PluginAgentEventSubscriptionRegistration,
  PluginRuntimeLifecycleRegistration,
} from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fiUserPlugin from "./index.js";

type Capability = {
  mode: string;
  assertCurrent(): void;
  authorizeRequester(policy: "own-accounts", signal?: AbortSignal): Promise<unknown>;
};
type Runtime = {
  protocol: string;
  capture(context: OpenClawPluginToolContext): Capability | undefined;
};
function fixture() {
  const hooks = new Map<string, (event: never, context: never) => unknown>();
  const subscriptions: PluginAgentEventSubscriptionRegistration[] = [];
  const lifecycles: PluginRuntimeLifecycleRegistration[] = [];
  let runtime: Runtime;
  fiUserPlugin.register?.(
    createTestPluginApi({
      id: "fi-user",
      name: "Fi User Delegation",
      config: {
        plugins: {
          entries: {
            "fi-user": {
              config: {
                baseUrl: "https://fi.test/fi",
                brokerTokenEnv: "VOICE_BROKER",
                matrixTenantOrgId: "tenant",
              },
            },
          },
        },
      },
      runtime: {
        channel: {
          runtimeContexts: {
            register: (registration: { capability: string; context: Runtime }) => {
              if (registration.capability === "fi-admitted-turn") runtime = registration.context;
              return { dispose() {} };
            },
          },
        },
      } as unknown as OpenClawPluginApi["runtime"],
      on: (name, handler) => {
        if (name === "before_agent_reply") hooks.set(name, handler as never);
      },
      registerAgentEventSubscription: (entry) => subscriptions.push(entry),
      registerRuntimeLifecycle: (entry) => lifecycles.push(entry),
    }),
  );
  const admit = (runId = "one", senderId = "@speaker:matrix.test", mode = "voice") => {
    const ctx = {
      runId,
      agentId: "cellect-fi-admin",
      accountId: "admin",
      channel: "matrix",
      senderId,
      chatId: "!room:matrix.test:thread:$root",
      sessionKey: "agent:cellect-fi-admin:matrix:channel:!room:matrix.test:thread:$root",
      channelContext: {
        sender: { id: senderId },
        chat: {
          id: "!room:matrix.test",
          ...(mode === "voice" ? { talkThreadRootEventId: "$root" } : { eventId: "$text" }),
        },
      },
    };
    return hooks.get("before_agent_reply")!({} as never, ctx as never);
  };
  const capture = (overrides = {}) =>
    runtime.capture({
      runId: "one",
      agentId: "cellect-fi-admin",
      agentAccountId: "admin",
      messageChannel: "matrix",
      sessionKey: "agent:cellect-fi-admin:matrix:channel:!room:matrix.test:thread:$root",
      requesterSenderId: "@speaker:matrix.test",
      nativeChannelId: "!room:matrix.test",
      ...overrides,
    });
  const settle = async (executionSettled: boolean) => {
    for (const sub of subscriptions)
      await sub.handle(
        { runId: "one", stream: "lifecycle", data: { phase: "end", executionSettled } } as never,
        {} as never,
      );
  };
  return {
    admit,
    capture,
    settle,
    dispose: () => Promise.all(lifecycles.map((x) => x.dispose?.())),
  };
}
const proof = () =>
  new Response(
    JSON.stringify({
      ok: true,
      agentId: "cellect-fi-admin",
      orgId: "tenant",
      googleRequester: {
        matrixUserId: "@speaker:matrix.test",
        email: "speaker@example.com",
        policy: "own-accounts",
        tier: "admin",
      },
    }),
  );
describe("registered Fi admitted-turn capability", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubEnv("VOICE_BROKER", "synthetic-broker");
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ admin: "prod" }));
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset().mockImplementation(async () => proof());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  it("uses the actual speaker and owner thread, and obtains fresh provider-neutral proof", async () => {
    const f = fixture();
    expect(f.capture()).toBeUndefined();
    await f.admit();
    const cap = f.capture()!;
    expect(cap.mode).toBe("voice");
    await cap.authorizeRequester("own-accounts");
    await cap.authorizeRequester("own-accounts");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      roomId: "!room:matrix.test",
      agentId: "cellect-fi-admin",
      mode: "voice",
      speakerMxid: "@speaker:matrix.test",
      threadRootEventId: "$root",
      recheck: true,
      googleRequester: "own-accounts",
    });
  });
  it("keeps concurrent runs in the same session separate and requires every native identity field", async () => {
    const f = fixture();
    await f.admit();
    await f.admit("two", "@other:matrix.test");
    expect(f.capture()).toBeDefined();
    expect(f.capture({ runId: "two", requesterSenderId: "@other:matrix.test" })).toBeDefined();
    for (const patch of [
      { runId: undefined },
      { runId: "two" },
      { agentId: "cellect-main" },
      { agentAccountId: "other" },
      { sessionKey: "other" },
      { nativeChannelId: "!other:matrix.test" },
      { requesterSenderId: "@other:matrix.test" },
      { currentMessageId: "$fake" },
    ])
      expect(f.capture(patch)).toBeUndefined();
  });
  it("captures exact text events and preserves fallback until outer settlement", async () => {
    const f = fixture();
    await f.admit("one", undefined, "text");
    expect(f.capture()).toBeUndefined();
    const cap = f.capture({ currentMessageId: "$text" })!;
    await f.settle(false);
    expect(() => cap.assertCurrent()).not.toThrow();
    await cap.authorizeRequester("own-accounts");
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body)).toEqual({
      roomId: "!room:matrix.test",
      agentId: "cellect-fi-admin",
      eventId: "$text",
      recheck: true,
      googleRequester: "own-accounts",
    });
    await f.settle(true);
    expect(() => cap.assertCurrent()).toThrow();
  });
  it.each(["replacement", "settlement", "abort", "disposal"])(
    "rejects %s during awaited proof",
    async (action) => {
      const f = fixture();
      await f.admit();
      const cap = f.capture()!;
      let release!: (response: Response) => void;
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      );
      const abort = new AbortController();
      const pending = cap.authorizeRequester("own-accounts", abort.signal);
      if (action === "replacement") await f.admit();
      if (action === "settlement") await f.settle(true);
      if (action === "abort") abort.abort();
      if (action === "disposal") await f.dispose();
      release(proof());
      await expect(pending).rejects.toThrow();
    },
  );
  it("refuses denied and cross-tenant fresh proofs and an expired host invocation", async () => {
    const f = fixture();
    await f.admit();
    const cap = f.capture()!;
    fetchMock.mockResolvedValueOnce(new Response("", { status: 403 }));
    await expect(cap.authorizeRequester("own-accounts")).rejects.toThrow();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, agentId: "cellect-fi-admin", orgId: "other" })),
    );
    await expect(cap.authorizeRequester("own-accounts")).rejects.toThrow();
    let closed = false;
    const expired = f.capture({
      assertInvocationCurrent: () => {
        if (closed) throw new Error("closed");
      },
    })!;
    closed = true;
    await expect(expired.authorizeRequester("own-accounts")).rejects.toThrow("closed");
  });
});
