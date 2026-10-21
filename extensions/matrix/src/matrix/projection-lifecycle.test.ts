import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
} from "openclaw/plugin-sdk/thread-bindings-session-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  send: vi.fn(),
}));
vi.mock("./thread-bindings-shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./thread-bindings-shared.js")>()),
  listAllBindings: () => mocks.rows,
  getMatrixThreadBindingManager: (accountId: string) =>
    mocks.stoppedAccounts.has(accountId) ? undefined : {},
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
  const accounts = ["admin", "main", "duplicate"];
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      lifecycle.stop();
      for (const accountId of accounts) {
        unregisterSessionBindingAdapter({ channel: "matrix", accountId });
      }
      cleanup();
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
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("matrix-participant-lifecycle-"));
    mocks.send.mockReset().mockResolvedValue("$accepted");
    mocks.stoppedAccounts.clear();
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
    const runtime = createPluginRuntimeMock();
    runtime.config.current = () => cfg;
    runtime.events.registerConversationLifecycleTransport = (options) => {
      transport = options;
      return { stop() {}, flush: async () => {}, noteResult() {}, resolveRun: () => undefined };
    };
    lifecycle = startMatrixProjectionLifecycle(createTestPluginApi({ config: cfg, runtime }));
  });
  it("resolves Admin and main to one canonical identity with their own execution and wire accounts", async () => {
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
  it("ignores an unrelated unbound account without requiring an ambient agent owner", () => {
    cfg.channels!.matrix!.accounts!.duplicate = {};
    expect(resolve("main")).toEqual([expect.objectContaining({ roomId, accountId: "main" })]);
  });
  it("keeps the native destination when main also has a direct binding in another room", () => {
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
  it.each([
    "source",
    "source-authorization",
    "other-root",
    "other-agent",
    "default-route",
    "disabled",
    "stopped",
    "ambiguous",
    "competing-binding",
  ])("does not infer a participant destination for %s", (scenario) => {
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
    if (scenario === "ambiguous") {
      cfg.channels!.matrix!.accounts!.duplicate = {};
      cfg.bindings!.push({ agentId: "main", match: { channel: "matrix", accountId: "duplicate" } });
    }
    if (scenario === "competing-binding") {
      mocks.rows.push({ ...canonical, conversationId: "$other" });
    }
    expect(resolve("main")).toEqual([]);
  });
});
