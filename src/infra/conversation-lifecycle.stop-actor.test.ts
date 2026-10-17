import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import {
  emitAgentEvent,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "./agent-events.js";
import { claimAgentRunContext } from "./agent-run-registry.js";
import {
  registerConversationLifecycleTransport,
  type ConversationLifecyclePublication,
  type ConversationProjectionBinding,
} from "./conversation-lifecycle.js";

describe("verified conversation stopper publication", () => {
  let stateDir: string;
  let close: (() => void) | undefined;
  let clock = 1_789_718_400_000;
  let failFacts = false;
  const facts: ConversationLifecyclePublication[] = [];
  const binding: ConversationProjectionBinding = {
    environment: "test",
    conversationId: "conversation-0001",
    roomId: "!room:matrix.test",
    bindingId: "binding-0001",
    accountId: "bot",
    threadRootEventId: "$root",
    sessionKey: "agent:example:main",
    agentId: "example",
  };
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "stop-actor-"));
    resetAgentEventsForTest();
    rotateAgentEventLifecycleGeneration();
    clock = 1_789_718_400_000;
    failFacts = false;
    facts.length = 0;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
  });
  afterEach(async () => {
    close?.();
    close = undefined;
    resetAgentEventsForTest();
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  function install(resolve: () => readonly ConversationProjectionBinding[] = () => [binding]) {
    const transport = registerConversationLifecycleTransport({
      transportId: "test-matrix",
      stateDir,
      resolveBindings: resolve,
      publish: async (_, event) => {
        if (failFacts) {
          throw new Error("wire down");
        }
        facts.push({ ...event });
      },
      signals: () => true,
      onError: () => {},
    });
    close = transport.stop;
    return transport;
  }
  function admit(runId: string) {
    claimAgentRunContext(
      runId,
      { sessionKey: binding.sessionKey, sessionId: "session", agentId: binding.agentId },
      { trackOwner: true },
    );
  }
  const emit = (runId: string, phase: string, data: Record<string, unknown> = {}) =>
    emitAgentEvent({ runId, stream: "lifecycle", data: { phase, startedAt: 1, ...data } });
  const approval = (runId: string, data: Record<string, unknown>) =>
    emitAgentEvent({ runId, stream: "approval", data });
  const plugin = (id: string) => ({
    phase: "requested",
    kind: "plugin",
    chatDecidable: true,
    status: "pending",
    title: "Approval",
    approvalId: id,
    expiresAtMs: clock + 120_000,
    allowedDecisions: ["allow-once", "deny"],
  });
  const of = (runId: string) => facts.filter((fact) => fact.runId === runId);

  it.each([
    { cause: "rpc", state: "cancelled", kind: "person" },
    { cause: "stop", state: "cancelled", kind: "person" },
    { cause: "aborted", state: "cancelled", kind: "person" },
    { cause: "timeout", state: "interrupted", kind: undefined },
    { cause: "restart", state: "cancelled", kind: undefined },
    { cause: "auth-revoked", state: "cancelled", kind: "auth_revoked" },
    { cause: "superseded", state: "cancelled", kind: "coordinator" },
    { cause: undefined, state: "cancelled", kind: undefined },
  ])("preserves $cause semantics instead of inferring a person", async ({ cause, state, kind }) => {
    const transport = install();
    admit("cause-stop");
    emit("cause-stop", "end", {
      status: "cancelled",
      aborted: true,
      stopReason: cause,
      stopActor: {
        userId: "@reader:matrix.test",
        roomId: binding.roomId,
        threadRootEventId: binding.threadRootEventId,
        sessionKey: binding.sessionKey,
        agentId: binding.agentId,
      },
    });
    await transport.flush();
    const terminal = of("cause-stop").at(-1);
    expect(terminal?.state).toBe(state);
    expect(terminal?.stoppedBy?.kind).toBe(kind);
    expect(terminal?.stoppedBy?.userId).toBe(kind === "person" ? "@reader:matrix.test" : undefined);
  });
  it("does not attach a later Stop actor when completion has already won", async () => {
    const transport = install();
    admit("completed-first");
    emit("completed-first", "end", { stopReason: "stop" });
    emit("completed-first", "end", {
      status: "cancelled",
      aborted: true,
      stopReason: "rpc",
      stopActor: {
        userId: "@reader:matrix.test",
        roomId: binding.roomId,
        threadRootEventId: binding.threadRootEventId,
        sessionKey: binding.sessionKey,
        agentId: binding.agentId,
      },
    });
    await transport.flush();
    expect(of("completed-first").at(-1)?.state).toBe("completed");
    expect(of("completed-first").at(-1)?.stoppedBy).toBeUndefined();
  });

  it.each(["queued", "running", "waiting"])(
    "keeps a verified stopper on its %s binding",
    async (phase) => {
      const foreign = { ...binding, bindingId: "other-root", threadRootEventId: "$other" };
      const transport = install(() => [binding, foreign]);
      admit("person-stop");
      if (phase !== "queued") {
        emit("person-stop", "start");
      }
      if (phase === "waiting") {
        approval("person-stop", plugin("person-approval"));
      }
      const stopActor = {
        userId: "@reader:matrix.test",
        roomId: binding.roomId,
        threadRootEventId: binding.threadRootEventId,
        sessionKey: binding.sessionKey,
        agentId: binding.agentId,
      };
      failFacts = true;
      emit("person-stop", "end", {
        status: "cancelled",
        aborted: true,
        stopReason: "rpc",
        stopActor,
      });
      await transport.flush();
      failFacts = false;
      clock += 60_000;
      await transport.flush();
      const terminals = of("person-stop").filter((fact) => fact.state === "cancelled");
      expect(terminals.find((fact) => fact.bindingId === binding.bindingId)?.stoppedBy).toEqual({
        kind: "person",
        userId: stopActor.userId,
      });
      expect(
        terminals.find((fact) => fact.bindingId === foreign.bindingId)?.stoppedBy,
      ).toBeUndefined();
    },
  );

  it.each(["roomId", "threadRootEventId", "sessionKey", "agentId"] as const)(
    "does not disclose a stopper from another %s",
    async (field) => {
      const transport = install();
      admit("foreign-person");
      const stopActor = {
        userId: "@reader:matrix.test",
        roomId: binding.roomId,
        threadRootEventId: binding.threadRootEventId,
        sessionKey: binding.sessionKey,
        agentId: binding.agentId,
        [field]: "foreign",
      };
      emit("foreign-person", "end", {
        status: "cancelled",
        aborted: true,
        stopReason: "rpc",
        stopActor,
      });
      await transport.flush();
      expect(of("foreign-person").at(-1)?.state).toBe("cancelled");
      expect(of("foreign-person").at(-1)?.stoppedBy).toBeUndefined();
    },
  );
});
