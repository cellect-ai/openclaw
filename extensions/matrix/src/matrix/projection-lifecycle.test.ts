import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
} from "openclaw/plugin-sdk/thread-bindings-session-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindReplyPublication } from "../../../../src/auto-reply/reply-publication.js";
import {
  emitAgentEvent,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../../../../src/infra/agent-events.js";
import { registerAgentRunContext } from "../../../../src/infra/agent-run-registry.js";
import { registerConversationLifecycleTransport } from "../../../../src/infra/conversation-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../../../../src/state/openclaw-state-db.js";
import type { CoreConfig } from "../types.js";
import {
  startMatrixProjectionLifecycle,
  resolveMatrixProjectionRun,
} from "./projection-lifecycle.js";
import {
  matrixPublicationContent,
  noteMatrixPublicationAccepted,
  resolveMatrixReplyPublication,
} from "./projection-publication.js";
import {
  toSessionBindingRecord,
  type MatrixThreadBindingRecord,
} from "./thread-bindings-shared.js";

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
    callback: (client: { sendEvent: typeof mocks.send }) => unknown,
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

// The Matrix adapter runs with real native route resolution and durable lifecycle
// custody. Only the homeserver wire and the already-loaded binding inventory are fixtures.
describe("native Matrix participant lifecycle publication", () => {
  let stateDir: string;
  let cfg: CoreConfig;
  let transport: ReturnType<typeof registerConversationLifecycleTransport>;
  let lifecycle: ReturnType<typeof startMatrixProjectionLifecycle>;
  const accounts = ["admin", "main", "duplicate"];
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(async () => {
      lifecycle.stop();
      for (const accountId of accounts)
        unregisterSessionBindingAdapter({ channel: "matrix", accountId });
      resetAgentEventsForTest();
      await closeOpenClawStateDatabaseAsync();
      cleanup();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });
  });
  function install() {
    const runtime = createPluginRuntimeMock();
    runtime.config.current = () => cfg;
    runtime.events.registerConversationLifecycleTransport = (options) => {
      transport = registerConversationLifecycleTransport({ ...options, stateDir });
      return transport;
    };
    lifecycle = startMatrixProjectionLifecycle(createTestPluginApi({ config: cfg, runtime }));
  }
  function admit(agent: string, key = sessionKey(agent)) {
    registerAgentRunContext(agent, {
      agentId: agent,
      sessionId: `session-${agent}`,
      sessionKey: key,
    });
  }
  function emit(agent: string, phase: string) {
    emitAgentEvent({ runId: agent, stream: "lifecycle", data: { phase, startedAt: 1 } });
  }
  beforeEach(() => {
    stateDir = tempDirs.make("matrix-participant-lifecycle-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    resetAgentEventsForTest();
    rotateAgentEventLifecycleGeneration();
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
    install();
  });
  it("publishes Admin and main under one canonical identity, with separate run and wire owners", async () => {
    // No execution has been admitted yet.
    await transport.flush();
    expect(mocks.send).not.toHaveBeenCalled();
    for (const agent of ["admin", "main"]) {
      admit(agent);
      emit(agent, "start");
    }
    await transport.flush();
    for (const agent of ["admin", "main"]) {
      expect(
        mocks.send.mock.calls.filter((call) => call[0] === agent).map((call) => call[3]),
      ).toEqual([
        expect.objectContaining({
          bindingId: `admin:${roomId}:${root}`,
          runId: agent,
          state: "queued",
        }),
        expect.objectContaining({
          bindingId: `admin:${roomId}:${root}`,
          runId: agent,
          state: "running",
        }),
      ]);
      const payload = { text: "Synthetic final result" };
      bindReplyPublication(payload, {
        payload,
        kind: "final",
        channel: "matrix",
        sessionKey: sessionKey(agent),
        runId: agent,
        context: { accountId: agent },
      });
      const publication = resolveMatrixReplyPublication(payload, agent, roomId, root);
      expect(publication).toBeDefined();
      if (!publication) throw new Error("Expected admitted participant publication");
      expect(matrixPublicationContent(publication, roomId, 0, 1)).toMatchObject({
        bindingId: `admin:${roomId}:${root}`,
        origin: { accountId: agent, actorId: agent },
      });
      noteMatrixPublicationAccepted(publication, roomId, `$result-${agent}`);
      emit(agent, "end");
    }
    await transport.flush();
    expect(
      mocks.send.mock.calls.filter((call) => call[3].state === "completed").map((call) => call[3]),
    ).toEqual(
      expect.arrayContaining(
        ["admin", "main"].map((agent) =>
          expect.objectContaining({
            runId: agent,
            resultEventId: `$result-${agent}`,
            bindingId: `admin:${roomId}:${root}`,
          }),
        ),
      ),
    );
    expect(mocks.rows).toEqual([canonical]);
  });
  it("keeps the native destination when main also has a direct binding in another room", async () => {
    mocks.rows.push({
      ...canonical,
      accountId: "main",
      agentId: "main",
      parentConversationId: "!other:example.org",
      conversationId: "$other",
      targetSessionKey: sessionKey("main"),
    });
    admit("main");
    emit("main", "start");
    await transport.flush();
    expect(
      mocks.send.mock.calls.filter((call) => call[1] === roomId).map((call) => call[3].state),
    ).toEqual(["queued", "running"]);
  });
  it("replays main's persisted destination after the adapter restarts without route state", async () => {
    mocks.send.mockRejectedValueOnce(new Error("temporary network failure"));
    admit("main");
    emit("main", "start");
    await transport.flush();
    expect(mocks.send).toHaveBeenCalled();
    const transactionId = mocks.send.mock.calls[0]?.[4];
    lifecycle.stop();
    resetAgentEventsForTest();
    mocks.rows = [];
    cfg.bindings = [];
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    install();
    await transport.flush();
    expect(mocks.send.mock.calls[1]).toEqual([
      "main",
      roomId,
      "m.cellect.conversation.lifecycle",
      expect.objectContaining({
        bindingId: `admin:${roomId}:${root}`,
        runId: "main",
        state: "queued",
      }),
      transactionId,
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
  ])("does not infer a participant destination for %s", async (scenario) => {
    const row = mocks.rows[0]!;
    if (scenario === "source") row.targetSessionKey = "agent:admin:slack:channel:c1";
    if (scenario === "source-authorization") row.sourceReplyAuthorization = "source-protocol";
    if (scenario === "other-root") row.conversationId = "$different-root";
    if (scenario === "other-agent")
      cfg.bindings = [{ agentId: "other", match: { channel: "matrix", accountId: "main" } }];
    if (scenario === "default-route")
      cfg.bindings = [{ agentId: "admin", match: { channel: "matrix", accountId: "admin" } }];
    if (scenario === "disabled") cfg.channels!.matrix!.accounts!.main!.enabled = false;
    if (scenario === "stopped") mocks.stoppedAccounts.add("main");
    if (scenario === "ambiguous") {
      cfg.channels!.matrix!.accounts!.duplicate = {};
      cfg.bindings!.push({ agentId: "main", match: { channel: "matrix", accountId: "duplicate" } });
    }
    if (scenario === "competing-binding")
      mocks.rows.push({ ...canonical, conversationId: "$other" });
    admit("main");
    emit("main", "start");
    emit("main", "end");
    await transport.flush();
    expect(resolveMatrixProjectionRun("main", sessionKey("main"))).toBeUndefined();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
