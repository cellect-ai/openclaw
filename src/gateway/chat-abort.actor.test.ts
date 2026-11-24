import { afterEach, expect, it, vi } from "vitest";
import { resolveAgentRunAbortLifecycleFields } from "../agents/run-termination.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { ConversationRunStopReason } from "../infra/run-stop-actor.js";
import type { VerifiedRunStopActor } from "../infra/run-stop-actor.js";
import {
  abortChatRunById,
  type ChatAbortControllerEntry,
  type ChatAbortOps,
} from "./chat-abort.js";
import { createChatRunState } from "./server-chat-state.js";

const actor: VerifiedRunStopActor = Object.freeze({
  userId: "@reader:matrix.test",
  roomId: "!room:matrix.test",
  threadRootEventId: "$root",
  agentId: "example",
  sessionKey: "agent:example:main",
});
afterEach(() => clearAgentRunContext("actor-run"));

it.each(["timeout", "restart", "auth-revoked", "superseded", undefined])(
  "does not replace a %s cause with a person signal",
  (stopReason) => {
    const controller = new AbortController();
    const entry: ChatAbortControllerEntry = {
      controller,
      sessionId: "actor-session",
      sessionKey: actor.sessionKey,
      agentId: actor.agentId,
      startedAtMs: 1,
      expiresAtMs: Date.now() + 60_000,
    };
    const ops: ChatAbortOps = {
      chatAbortControllers: new Map([["actor-run", entry]]),
      chatRunState: createChatRunState(),
      removeChatRun: vi.fn(),
      agentRunSeq: new Map(),
      broadcast: vi.fn(),
      nodeSendToSession: vi.fn(),
    };
    expect(
      abortChatRunById(ops, {
        runId: "actor-run",
        sessionKey: entry.sessionKey,
        stopReason,
        stopActor: actor,
      }).aborted,
    ).toBe(true);
    expect(entry.stopActor).toBeUndefined();
    expect(controller.signal.reason).not.toBeInstanceOf(ConversationRunStopReason);
    const terminal = resolveAgentRunAbortLifecycleFields(controller.signal);
    expect(terminal.stopActor).toBeUndefined();
    if (stopReason === "timeout" || stopReason === "restart") {
      expect(terminal.stopReason).toBe(stopReason);
    }
  },
);

it.each(["matching", "foreign-session", "foreign-agent", "settled", "reentrant", "absent"])(
  "records only the winning %s Stop actor before synchronous abort listeners",
  (mode) => {
    const controller = new AbortController();
    const entry: ChatAbortControllerEntry = {
      controller,
      sessionId: "actor-session",
      sessionKey: actor.sessionKey,
      agentId: actor.agentId,
      startedAtMs: 1,
      expiresAtMs: Date.now() + 60_000,
      isAbortable: () => mode !== "settled",
    };
    registerAgentRunContext("actor-run", {
      sessionKey: entry.sessionKey,
      sessionId: entry.sessionId,
      agentId: entry.agentId,
    });
    const ops: ChatAbortOps = {
      chatAbortControllers: new Map([["actor-run", entry]]),
      chatRunState: createChatRunState(),
      removeChatRun: vi.fn(),
      agentRunSeq: new Map(),
      broadcast: vi.fn(),
      nodeSendToSession: vi.fn(),
    };
    const matching = mode === "matching" || mode === "reentrant";
    const accepted = mode !== "settled" && mode !== "absent";
    if (mode === "absent") {
      ops.chatAbortControllers.clear();
    }
    const nested = vi.fn();
    if (mode === "reentrant") {
      ops.onRunAborted = () =>
        nested(
          abortChatRunById(ops, {
            runId: "actor-run",
            sessionKey: entry.sessionKey,
            stopReason: "rpc",
            stopActor: { ...actor, userId: "@second:matrix.test" },
          }),
        );
    }
    const supplied = {
      ...actor,
      ...(mode === "foreign-session" ? { sessionKey: "foreign" } : {}),
      ...(mode === "foreign-agent" ? { agentId: "foreign" } : {}),
    };
    const observed: unknown[] = [];
    controller.signal.addEventListener("abort", () => {
      observed.push(resolveAgentRunAbortLifecycleFields(controller.signal).stopActor);
    });
    const facts: unknown[] = [];
    const stop = onAgentEvent((event) => {
      if (event.runId === "actor-run") {
        facts.push(event.data.stopActor);
      }
    });
    try {
      expect(
        abortChatRunById(ops, {
          runId: "actor-run",
          sessionKey: entry.sessionKey,
          stopReason: "rpc",
          stopActor: supplied,
        }).aborted,
      ).toBe(accepted);
      expect(observed).toEqual(!accepted ? [] : [matching ? actor : undefined]);
      expect(facts).toEqual(!accepted ? [] : [matching ? actor : undefined]);
      expect(
        abortChatRunById(ops, {
          runId: "actor-run",
          sessionKey: entry.sessionKey,
          stopReason: "rpc",
          stopActor: { ...actor, userId: "@late:matrix.test" },
        }).aborted,
      ).toBe(false);
      expect(entry.stopActor).toEqual(matching ? actor : undefined);
      if (mode === "reentrant") {
        expect(nested).toHaveBeenCalledExactlyOnceWith({ aborted: false });
      }
    } finally {
      stop();
    }
  },
);
