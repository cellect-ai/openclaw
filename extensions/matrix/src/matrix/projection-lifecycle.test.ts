import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import "openclaw/plugin-sdk/compiled-subprocess-testing";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
} from "openclaw/plugin-sdk/thread-bindings-session-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  admitMatrixProjectionExecution,
  restoreMatrixProjectionExecutions,
} from "./projection-execution.js";
import { startMatrixProjectionLifecycle } from "./projection-lifecycle.js";
import {
  toSessionBindingRecord,
  type MatrixThreadBindingRecord,
} from "./thread-bindings-shared.js";

type RegisterTransport =
  OpenClawPluginApi["runtime"]["events"]["registerConversationLifecycleTransport"];
type TransportOptions = Parameters<RegisterTransport>[0];
const mocks = vi.hoisted(() => ({
  rows: [] as MatrixThreadBindingRecord[],
  stoppedAccounts: new Set<string>(),
  managers: new Map<string, object>(),
  send: vi.fn(),
}));
vi.mock("./thread-bindings-shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./thread-bindings-shared.js")>()),
  listAllBindings: () => mocks.rows,
  getMatrixThreadBindingManager: (accountId: string) =>
    mocks.stoppedAccounts.has(accountId) ? undefined : mocks.managers.get(accountId),
}));
vi.mock("./send/client.js", () => ({
  withResolvedMatrixSendClient: (
    options: { accountId: string },
    callback: (client: { sendEvent: (...args: unknown[]) => Promise<string> }) => unknown,
  ) => callback({ sendEvent: (...args: unknown[]) => mocks.send(options.accountId, ...args) }),
}));

const roomId = "!Native:example.org";
const root = "$CaseSensitiveRoot";
const sessionKey = (agent: string) => `agent:${agent}:matrix:channel:${roomId}:thread:${root}`;
const canonical: MatrixThreadBindingRecord = {
  accountId: "admin",
  agentId: "admin",
  conversationId: root,
  parentConversationId: roomId,
  targetSessionKey: sessionKey("admin"),
  targetKind: "acp",
  boundBy: "session-projection",
  environment: "test",
  projectedConversationId: "conversation",
  boundAt: 1,
  lastActivityAt: 1,
};

// Exercise the callbacks installed at the host transport boundary with real
// native routing and registered binding adapters. Core owns run admission/replay.
describe("native Matrix participant lifecycle adapter", () => {
  let cfg: OpenClawConfig;
  let transport: TransportOptions;
  let lifecycle: ReturnType<typeof startMatrixProjectionLifecycle>;
  let runtime: ReturnType<typeof createPluginRuntimeMock>;
  let saved: Map<string, unknown>;
  const accounts = ["admin", "main", "duplicate"];
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      lifecycle.stop();
      for (const accountId of accounts) {
        unregisterSessionBindingAdapter({ channel: "matrix", accountId });
      }
      cleanup();
      resetPluginStateStoreForTests();
      vi.unstubAllEnvs();
    });
  });
  function resolve(agent: string) {
    return transport.resolveBindings({
      agentId: agent,
      sessionId: `session-${agent}`,
      sessionKey: sessionKey(agent),
    });
  }
  function admit(agent = "main", accountId = agent, threadRootEventId = root) {
    return admitMatrixProjectionExecution({
      core: runtime,
      cfg,
      accountId,
      agentId: agent,
      roomId,
      threadRootEventId,
      sessionKey: sessionKey(agent),
      client: {
        getUserId: async () => `@${accountId}:example.org`,
        getJoinedRooms: async () => [roomId],
      },
    });
  }
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("matrix-participant-lifecycle-"));
    mocks.send.mockReset().mockResolvedValue("$accepted");
    mocks.stoppedAccounts.clear();
    mocks.managers.clear();
    for (const accountId of accounts) mocks.managers.set(accountId, {});
    mocks.rows = [{ ...canonical }];
    cfg = {
      agents: { entries: { admin: {}, main: {}, other: {} } },
      channels: { matrix: { accounts: { admin: {}, main: {} } } },
      bindings: ["admin", "main"].map((agentId) => ({
        agentId,
        match: { channel: "matrix", accountId: agentId },
      })),
    };
    for (const accountId of accounts) {
      const records = () =>
        mocks.rows
          .filter((row) => row.accountId === accountId)
          .map((row) => toSessionBindingRecord(row, { idleTimeoutMs: 0, maxAgeMs: 0 }));
      registerSessionBindingAdapter({
        channel: "matrix",
        accountId,
        listBySession: (key) => records().filter((row) => row.targetSessionKey === key),
        inspectByConversation: (ref) =>
          records().find(
            (row) =>
              row.conversation.conversationId === ref.conversationId &&
              row.conversation.parentConversationId === ref.parentConversationId,
          ) ?? null,
        resolveByConversation: () => {
          throw new Error("Route inspection must stay read-only");
        },
      });
    }
    runtime = createPluginRuntimeMock();
    saved = new Map();
    runtime.state.openKeyedStore = vi.fn().mockReturnValue({
      entries: async () => [...saved].map(([key, value]) => ({ key, value, createdAt: 1 })),
      lookup: async (key: string) => saved.get(key),
      registerIfAbsent: async (key: string, value: unknown) => {
        if (saved.has(key)) return false;
        saved.set(key, value);
        return true;
      },
    });
    runtime.config.current = () => cfg;
    runtime.events.registerConversationLifecycleTransport = (options) => {
      transport = options;
      return { stop() {}, flush: async () => {}, noteResult() {}, resolveRun: () => undefined };
    };
    lifecycle = startMatrixProjectionLifecycle(createTestPluginApi({ config: cfg, runtime }));
  });
  it("resolves Admin and main to one canonical identity with their own execution and wire accounts", async () => {
    await Promise.all([admit("admin"), admit("main")]);
    for (const agent of ["admin", "main"]) {
      const bindings = resolve(agent);
      expect(bindings).toEqual([
        {
          environment: "test",
          conversationId: "conversation",
          roomId,
          bindingId: `admin:${roomId}:${root}`,
          accountId: agent,
          threadRootEventId: root,
          sessionKey: sessionKey(agent),
          agentId: agent,
        },
      ]);
      const binding = bindings[0];
      if (!binding) {
        throw new Error("Expected native participant destination");
      }
      await transport.publish(
        binding,
        {
          version: 2,
          environment: "test",
          conversationId: "conversation",
          roomId,
          bindingId: `admin:${roomId}:${root}`,
          runId: `run-${agent}`,
          generation: "host-generation",
          revision: 1,
          state: "running",
        },
        `transaction-${agent}`,
      );
      expect(mocks.send).toHaveBeenLastCalledWith(
        agent,
        roomId,
        "m.cellect.conversation.lifecycle",
        expect.objectContaining({
          bindingId: `admin:${roomId}:${root}`,
          runId: `run-${agent}`,
          state: "running",
        }),
        `transaction-${agent}`,
      );
    }
    expect(mocks.rows).toEqual([canonical]);
  });
  it("ignores an unrelated unbound account without requiring an ambient agent owner", async () => {
    cfg.channels!.matrix!.accounts!.duplicate = {};
    await admit();
    expect(resolve("main")).toEqual([expect.objectContaining({ roomId, accountId: "main" })]);
  });
  it("keeps the native destination when main also has a direct binding in another room", async () => {
    await admit();
    mocks.rows.push({
      ...canonical,
      accountId: "main",
      agentId: "main",
      parentConversationId: "!other:example.org",
      conversationId: "$other",
      targetSessionKey: sessionKey("main"),
    });
    expect(resolve("main").map((binding) => binding.roomId)).toEqual([
      "!other:example.org",
      roomId,
    ]);
  });
  it("admits the actual account when production and dev accounts route to the same native session", async () => {
    cfg.channels!.matrix!.accounts!.duplicate = {};
    cfg.bindings!.push({ agentId: "main", match: { channel: "matrix", accountId: "duplicate" } });
    // The prior resolver inferred accounts from config and returned nothing here.
    expect(resolve("main")).toEqual([]);
    await admit("main", "main");
    expect(resolve("main")).toEqual([expect.objectContaining({ accountId: "main" })]);
    expect(mocks.rows).toEqual([canonical]);
    await expect(admit("main", "duplicate")).rejects.toThrow("execution_owner_conflict");
    expect(resolve("main")).toEqual([expect.objectContaining({ accountId: "main" })]);
  });
  it("requires native admission rather than treating seating/configuration as publication authority", () => {
    expect(resolve("main")).toEqual([]);
    expect(runtime.state.openKeyedStore).not.toHaveBeenCalled();
  });
  it("reconciles an existing durable relationship idempotently and refuses contradictory identity", async () => {
    await admit();
    const original = [...saved.values()];
    await admit();
    expect([...saved.values()]).toEqual(original);
    const [key, value] = [...saved.entries()][0]!;
    saved.set(key, { ...(value as Record<string, unknown>), producerMxid: "@other:example.org" });
    await expect(admit()).rejects.toThrow("relation_conflict");
  });
  it("fails closed before dispatch for an incorrect thread root or non-joined producer", async () => {
    await expect(admit("main", "main", "$wrong")).rejects.toThrow("identity_mismatch");
    await expect(
      admitMatrixProjectionExecution({
        core: runtime,
        cfg,
        accountId: "main",
        agentId: "main",
        roomId,
        threadRootEventId: root,
        sessionKey: sessionKey("main"),
        client: { getUserId: async () => "@main:example.org", getJoinedRooms: async () => [] },
      }),
    ).rejects.toThrow("producer_not_joined");
    expect(saved.size).toBe(0);
  });
  it("does not publish an acknowledged relationship after its live manager is replaced", async () => {
    await admit();
    mocks.managers.set("main", {});
    expect(resolve("main")).toEqual([]);
    await admit();
    expect(resolve("main")).toHaveLength(1);
  });
  it("restores a durable relationship on account startup without another user message", async () => {
    await admit();
    mocks.managers.set("main", {});
    expect(resolve("main")).toEqual([]);
    // Account startup order must not matter: the canonical account can load last.
    mocks.rows = [];
    await restoreMatrixProjectionExecutions({
      core: runtime,
      accountId: "main",
      client: { getUserId: async () => "@main:example.org", getJoinedRooms: async () => [roomId] },
    });
    expect(resolve("main")).toEqual([]);
    mocks.rows = [{ ...canonical }];
    expect(resolve("main")).toEqual([expect.objectContaining({ accountId: "main" })]);
  });
  it("recovers an execution from the actual worker-backed plugin SQLite namespace", async () => {
    runtime.state.openKeyedStore = (options) =>
      createPluginStateKeyedStoreForTests("matrix", options);
    await admit();
    mocks.managers.set("main", {});
    expect(resolve("main")).toEqual([]);
    await restoreMatrixProjectionExecutions({
      core: runtime,
      accountId: "main",
      client: { getUserId: async () => "@main:example.org", getJoinedRooms: async () => [roomId] },
    });
    expect(resolve("main")).toEqual([expect.objectContaining({ accountId: "main", roomId })]);
  });
  it.each(["not-joined", "wrong-producer", "wrong-key"])(
    "refuses restored publication for %s",
    async (scenario) => {
      await admit();
      mocks.managers.set("main", {});
      if (scenario === "wrong-key") {
        const entry = [...saved][0];
        if (!entry) throw new Error("Expected a persisted execution relationship");
        const [key, value] = entry;
        saved.delete(key);
        saved.set("incorrect-key", value);
      }
      await restoreMatrixProjectionExecutions({
        core: runtime,
        accountId: "main",
        client: {
          getUserId: async () =>
            scenario === "wrong-producer" ? "@other:example.org" : "@main:example.org",
          getJoinedRooms: async () => (scenario === "not-joined" ? [] : [roomId]),
        },
      });
      expect(resolve("main")).toEqual([]);
    },
  );
  it.each(["environment", "projectedConversationId"] as const)(
    "refuses a relationship when canonical %s changes",
    async (field) => {
      await admit();
      mocks.rows[0]![field] = "another-tenant-conversation";
      expect(resolve("main")).toEqual([]);
    },
  );
  it.each([
    "source",
    "source-authorization",
    "other-root",
    "other-agent",
    "default-route",
    "disabled",
    "stopped",
    "competing-binding",
  ])("does not retain an admitted participant destination for %s", async (scenario) => {
    await admit();
    const row = mocks.rows[0]!;
    if (scenario === "source") {
      row.targetSessionKey = "agent:admin:slack:channel:c1";
    }
    if (scenario === "source-authorization") {
      row.sourceReplyAuthorization = "source-protocol";
    }
    if (scenario === "other-root") {
      row.conversationId = "$different-root";
    }
    if (scenario === "other-agent") {
      cfg.bindings = [{ agentId: "other", match: { channel: "matrix", accountId: "main" } }];
    }
    if (scenario === "default-route") {
      cfg.bindings = [{ agentId: "admin", match: { channel: "matrix", accountId: "admin" } }];
    }
    if (scenario === "disabled") {
      cfg.channels!.matrix!.accounts!.main!.enabled = false;
    }
    if (scenario === "stopped") {
      mocks.stoppedAccounts.add("main");
    }
    if (scenario === "competing-binding") {
      mocks.rows.push({ ...canonical, conversationId: "$other" });
    }
    expect(resolve("main")).toEqual([]);
  });
});
