import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestApprovalFixture } from "../gateway/exec-approval-manager.test-support.js";
import { createOperatorApprovalSessionEventRuntime } from "../gateway/operator-approval-session-events.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import {
  emitAgentEvent,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "./agent-events.js";
import {
  claimAgentRunContext,
  getAgentRunContext,
  getAgentRunLifecycleGeneration,
  registerAgentRunContext,
  sweepStaleRunContexts,
} from "./agent-run-registry.js";
import {
  registerConversationLifecycleTransport,
  type ConversationLifecyclePublication,
  type ConversationProjectionBinding,
} from "./conversation-lifecycle.js";
import * as custody from "./delivery-queue-sqlite.js";
import type { PluginApprovalRequestPayload } from "./plugin-approvals.js";
import {
  isDecisionCard,
  isRunHeartbeat,
  parseRunLifecycle,
  reduceRunLifecycle,
  type RunLifecycle,
} from "./test-fixtures/cellect-threads/kit-contract.js";

// Contract v2: the optional fields and the heartbeat, as they leave the gateway.
// Every fact is held to the consumer port, which the shared fixtures pin.
const T0 = 1_789_718_400_000;
const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(here, "test-fixtures/cellect-threads/gateway-emitted-lifecycle-v2.json");

describe("conversation lifecycle, contract v2", () => {
  let stateDir: string;
  let stop: (() => void)[];
  let clock = T0;
  const flags = { signals: true, cards: true };
  const facts: ConversationLifecyclePublication[] = [];
  const cards: { content: Record<string, unknown>; transactionId: string }[] = [];
  const errors: { roomId?: string; reason?: string; failures?: number }[] = [];
  let failCards = false;
  let failFacts = false;
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
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-signals-"));
    resetAgentEventsForTest();
    rotateAgentEventLifecycleGeneration();
    clock = T0;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    facts.length = 0;
    cards.length = 0;
    errors.length = 0;
    failCards = false;
    failFacts = false;
    flags.signals = true;
    flags.cards = true;
    stop = [];
  });
  afterEach(async () => {
    for (const close of stop) {
      close();
    }
    resetAgentEventsForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
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
      publishDecision: async (_, content, transactionId) => {
        if (failCards) {
          throw new Error("card wire down");
        }
        cards.push({ content, transactionId });
      },
      signals: () => flags.signals,
      decisionCards: () => flags.cards,
      onError: (_, detail) => {
        errors.push({ ...detail });
      },
    });
    stop.push(transport.stop);
    return transport;
  }
  /** An admitted run whose executor holds its claim, as a running agent does. */
  function admit(runId: string, claim = true) {
    const context = {
      sessionKey: binding.sessionKey,
      sessionId: "session",
      agentId: binding.agentId,
    };
    if (claim) {
      claimAgentRunContext(runId, context, { trackOwner: true });
    } else {
      registerAgentRunContext(runId, context);
    }
  }
  const emit = (runId: string, phase: string, data: Record<string, unknown> = {}) =>
    emitAgentEvent({ runId, stream: "lifecycle", data: { phase, startedAt: 1, ...data } });
  const approval = (runId: string, data: Record<string, unknown>) =>
    emitAgentEvent({ runId, stream: "approval", data });
  // An approval whose emitter says a person may decide it from the conversation.
  const plugin = (id: string, extra: Record<string, unknown> = {}) => ({
    phase: "requested",
    kind: "plugin",
    chatDecidable: true,
    status: "pending",
    title: "Plugin approval requested",
    approvalId: id,
    expiresAtMs: clock + 120_000,
    allowedDecisions: ["allow-once", "deny"],
    conversation: { title: "Approve a payment", summary: "Pay 49.99 EUR to the supplier" },
    ...extra,
  });
  const stored = () =>
    custody.loadDeliveryQueueEntries("conversation-lifecycle-v2", stateDir) as unknown as Record<
      string,
      unknown
    >[];
  const of = (runId: string) => facts.filter((fact) => fact.runId === runId);
  const states = (runId: string) => of(runId).map((fact) => fact.state);
  const signalKeys = new Set(["atMs", "admittedAtMs", "waitingOn", "failureKind", "stoppedBy"]);

  /** The consumer's view: every fact parses and reduces in revision order. */
  function consume(runId: string): RunLifecycle {
    let state: RunLifecycle | null = null;
    for (const fact of of(runId)) {
      expect(() => parseRunLifecycle(fact), `${fact.state}@${fact.revision}`).not.toThrow();
      state = reduceRunLifecycle(state, fact as never, { receivedAtMs: fact.atMs ?? clock });
    }
    return state!;
  }

  it("with the flag off sends exactly the facts the earlier contract knew", async () => {
    flags.signals = false;
    const transport = install();
    admit("run");
    emit("run", "start");
    approval("run", plugin("approval-1"));
    approval("run", {
      phase: "resolved",
      kind: "plugin",
      status: "approved",
      approvalId: "approval-1",
    });
    emit("run", "error", { error: "429 rate limit exceeded", fallbackExhaustedFailure: true });
    await transport.flush();
    expect(states("run").at(-1)).toBe("failed");
    expect(facts.length).toBeGreaterThan(3);
    for (const fact of facts) {
      expect(Object.keys(fact).filter((key) => signalKeys.has(key))).toEqual([]);
    }
    expect(consume("run").state).toBe(states("run").at(-1));
  });

  it("with the flag on stamps every fact: the run's admission once, the producer's clock forward", async () => {
    const transport = install();
    admit("run");
    clock = T0 + 1_000;
    emit("run", "start");
    clock = T0 + 2_000;
    emit("run", "end");
    await transport.flush();
    expect(states("run")).toEqual(["queued", "running", "completed"]);
    expect(of("run").map((fact) => fact.atMs)).toEqual([T0, T0 + 1_000, T0 + 2_000]);
    expect(of("run").every((fact) => fact.admittedAtMs === T0)).toBe(true);
    expect(consume("run")).toMatchObject({
      state: "completed",
      atMs: T0 + 2_000,
      admittedAtMs: T0,
    });
  });

  it("keeps atMs strictly forward when the clock does not move", async () => {
    const transport = install();
    admit("run");
    emit("run", "start");
    emit("run", "end");
    await transport.flush();
    expect(of("run").map((fact) => fact.atMs)).toEqual([T0, T0 + 1, T0 + 2]);
  });

  it("takes the run's place from admission, not from the room binding appearing later", async () => {
    let bound = false;
    const transport = install(() => (bound ? [binding] : []));
    admit("late");
    clock = T0 + 5_000;
    emit("late", "start");
    await transport.flush();
    expect(facts).toEqual([]);
    clock = T0 + 90_000;
    bound = true;
    await transport.flush();
    await transport.flush();
    expect(of("late").length).toBeGreaterThan(0);
    expect(of("late").every((fact) => fact.admittedAtMs === T0)).toBe(true);
    expect(of("late")[0]!.atMs).toBeGreaterThanOrEqual(T0);
  });

  it("says why a run failed, in the gateway's chat vocabulary", async () => {
    const transport = install();
    admit("failing");
    emit("failing", "start");
    emit("failing", "error", { error: "429 rate limit exceeded", fallbackExhaustedFailure: true });
    await transport.flush();
    const last = of("failing").at(-1)!;
    expect(last.state).toBe("failed");
    expect(last.failureKind).toBe("rate_limit");
    expect(of("failing").filter((fact) => fact.failureKind !== undefined)).toHaveLength(1);
    consume("failing");
  });

  it("says the system stopped a superseded run and names nobody for a plain abort", async () => {
    const transport = install();
    admit("replaced");
    emit("replaced", "start");
    emit("replaced", "end", { aborted: true, stopReason: "superseded" });
    admit("aborted");
    emit("aborted", "start");
    emit("aborted", "end", { aborted: true });
    await transport.flush();
    expect(of("replaced").at(-1)).toMatchObject({
      state: "cancelled",
      stoppedBy: { kind: "coordinator" },
    });
    expect(of("aborted").at(-1)!.state).toBe("cancelled");
    expect(of("aborted").at(-1)!.stoppedBy).toBeUndefined();
    consume("replaced");
    consume("aborted");
  });

  it("keeps the failure kind when the terminal fact is restated with its result", async () => {
    const transport = install();
    admit("restated");
    emit("restated", "start");
    emit("restated", "error", {
      error: "context length exceeded: prompt is too long",
      fallbackExhaustedFailure: true,
    });
    await transport.flush();
    transport.noteResult({
      runId: "restated",
      generation: getAgentRunLifecycleGeneration(),
      bindingId: binding.bindingId,
      resultEventId: "$result",
    });
    await transport.flush();
    expect(of("restated").at(-1)).toMatchObject({
      state: "failed",
      failureKind: "context_length",
      resultEventId: "$result",
    });
    expect(consume("restated").failureKind).toBe("context_length");
  });

  describe("what a waiting run names", () => {
    it("names the plugin approval, by the gateway's own id, when decision cards are on", async () => {
      const transport = install();
      admit("run");
      emit("run", "start");
      approval("run", plugin("approval-0001"));
      await transport.flush();
      expect(of("run").at(-1)).toMatchObject({
        state: "waiting",
        waitingOn: { kind: "confirmation", ref: "approval-0001" },
      });
      consume("run");
    });

    it("names nothing while decision cards are off, because there is no card to name", async () => {
      flags.cards = false;
      const transport = install();
      admit("run");
      emit("run", "start");
      approval("run", plugin("approval-0001"));
      await transport.flush();
      expect(of("run").at(-1)!.state).toBe("waiting");
      expect(of("run").at(-1)!.waitingOn).toBeUndefined();
      expect(of("run").at(-1)!.atMs).toBeDefined();
      expect(cards).toEqual([]);
    });

    it("names nothing for a command approval or one without the gateway's id", async () => {
      const transport = install();
      admit("exec");
      emit("exec", "start");
      approval("exec", { ...plugin("approval-x"), kind: "exec" });
      admit("noid");
      emit("noid", "start");
      approval("noid", { ...plugin("ignored", { approvalId: undefined, itemId: "item-1" }) });
      await transport.flush();
      expect(of("exec").at(-1)).toMatchObject({ state: "waiting" });
      expect(of("exec").at(-1)!.waitingOn).toBeUndefined();
      expect(of("noid").at(-1)!.waitingOn).toBeUndefined();
      expect(cards).toEqual([]);
    });

    it("names the next approval when the first is answered and the run keeps waiting", async () => {
      const transport = install();
      admit("run");
      emit("run", "start");
      approval("run", plugin("approval-1"));
      approval("run", plugin("approval-2"));
      approval("run", {
        phase: "resolved",
        kind: "plugin",
        status: "approved",
        approvalId: "approval-1",
      });
      await transport.flush();
      const waiting = of("run").filter((fact) => fact.state === "waiting");
      expect(waiting.map((fact) => fact.waitingOn?.ref)).toEqual(["approval-1", "approval-2"]);
      approval("run", {
        phase: "resolved",
        kind: "plugin",
        status: "approved",
        approvalId: "approval-2",
      });
      await transport.flush();
      expect(of("run").at(-1)).toMatchObject({ state: "running" });
      expect(of("run").at(-1)!.waitingOn).toBeUndefined();
      consume("run");
    });
  });

  describe("the heartbeat", () => {
    it("restates a live run's state under the next revision with a newer atMs, and nothing else", async () => {
      const transport = install();
      admit("run");
      emit("run", "start");
      await transport.flush();
      const before = of("run").at(-1)!;
      clock = T0 + 61_000;
      await transport.flush();
      const beat = of("run").at(-1)!;
      expect(beat.revision).toBe(before.revision + 1);
      expect(beat.state).toBe("running");
      expect(beat.atMs).toBeGreaterThan(before.atMs!);
      expect(isRunHeartbeat(before as never, beat as never)).toBe(true);
      // Not again until the interval has passed.
      await transport.flush();
      expect(of("run").at(-1)).toBe(beat);
      clock = T0 + 125_000;
      await transport.flush();
      expect(of("run")).toHaveLength(states("run").length);
      expect(of("run").at(-1)!.revision).toBe(beat.revision + 1);
      expect(consume("run")).toMatchObject({ state: "running", atMs: of("run").at(-1)!.atMs });
    });

    it("restates what a waiting run waits on", async () => {
      const transport = install();
      admit("run");
      emit("run", "start");
      approval("run", plugin("approval-0001"));
      await transport.flush();
      const waiting = of("run").at(-1)!;
      clock = T0 + 61_000;
      await transport.flush();
      const beat = of("run").at(-1)!;
      expect(beat).toMatchObject({
        state: "waiting",
        waitingOn: { kind: "confirmation", ref: "approval-0001" },
      });
      expect(isRunHeartbeat(waiting as never, beat as never)).toBe(true);
    });

    it("is sent only while nothing else of the run waits to be sent", async () => {
      const transport = install();
      admit("run");
      emit("run", "start");
      await transport.flush();
      failFacts = true;
      emit("run", "end");
      clock = T0 + 61_000;
      await transport.flush();
      clock = T0 + 200_000;
      await transport.flush();
      failFacts = false;
      expect(states("run")).toEqual(["queued", "running"]);
      clock = T0 + 400_000;
      await transport.flush();
      await transport.flush();
      expect(states("run").at(-1)).toBe("completed");
      expect(of("run").filter((fact) => fact.state === "running")).toHaveLength(1);
    });

    it("stops with the executor, and never follows a terminal state", async () => {
      const transport = install();
      admit("dead", false);
      emit("dead", "start");
      admit("done");
      emit("done", "start");
      emit("done", "end");
      await transport.flush();
      const sent = facts.length;
      clock = T0 + 61_000;
      await transport.flush();
      expect(of("dead").filter((fact) => fact.state === "running")).toHaveLength(1);
      expect(of("done").at(-1)!.state).toBe("completed");
      expect(facts.length).toBe(sent);
    });

    it("is not sent with the flag off, and the registry is left as it was", async () => {
      flags.signals = false;
      const transport = install();
      admit("run");
      emit("run", "start");
      await transport.flush();
      const activeBefore = getAgentRunContext("run")!.lastActiveAt;
      clock = T0 + 61_000;
      await transport.flush();
      expect(of("run")).toHaveLength(2);
      expect(getAgentRunContext("run")!.lastActiveAt).toBe(activeBefore);
    });

    it("does not keep a hung executor out of the silence sweep: it is swept and reported interrupted on schedule", async () => {
      const transport = install();
      admit("hung");
      emit("hung", "start");
      await transport.flush();
      for (const minute of [10, 20, 29]) {
        clock = T0 + minute * 60_000;
        await transport.flush();
      }
      const beats = of("hung").filter((fact) => fact.state === "running").length;
      expect(beats).toBeGreaterThan(2);
      clock = T0 + 31 * 60_000;
      expect(sweepStaleRunContexts()).toBe(1);
      expect(getAgentRunContext("hung")).toBeUndefined();
      await transport.flush();
      // The sweep took the claim with the context: no heartbeat follows it.
      expect(of("hung").filter((fact) => fact.state === "running")).toHaveLength(beats);
      clock = T0 + 62 * 60_000;
      await transport.flush();
      expect(of("hung").at(-1)!.state).toBe("interrupted");
    });

    it("stops vouching for a wait on a person after its first hour", async () => {
      const transport = install();
      admit("waiting");
      emit("waiting", "start");
      approval("waiting", plugin("approval-0001"));
      await transport.flush();
      for (let minute = 1; minute <= 75; minute += 1) {
        clock = T0 + minute * 60_000;
        await transport.flush();
      }
      const waiting = of("waiting").filter((fact) => fact.state === "waiting");
      expect(waiting.length).toBeGreaterThan(50);
      expect(waiting.at(-1)!.atMs!).toBeLessThanOrEqual(T0 + 61 * 60_000);
      consume("waiting");
    });
  });

  describe("the switch is read when a fact is sent", () => {
    it("sends a fact recorded with the flag on as the earlier contract when it is off by then", async () => {
      const transport = install();
      admit("run");
      emit("run", "start");
      flags.signals = false;
      await transport.flush();
      expect(of("run")).toHaveLength(2);
      for (const fact of of("run")) {
        expect(Object.keys(fact).filter((key) => signalKeys.has(key))).toEqual([]);
      }
    });

    it("sends a fact recorded with the flag off bare even once it is on: nothing was stamped", async () => {
      flags.signals = false;
      const transport = install();
      admit("run");
      emit("run", "start");
      flags.signals = true;
      await transport.flush();
      expect(of("run")).toHaveLength(2);
      for (const fact of of("run")) {
        expect(Object.keys(fact).filter((key) => signalKeys.has(key))).toEqual([]);
      }
    });
  });

  describe("what is stored", () => {
    const baseFact = new Set([
      "version",
      "environment",
      "conversationId",
      "roomId",
      "bindingId",
      "runId",
      "generation",
      "revision",
      "state",
      "resultEventId",
    ]);
    const newRowKeys = new Set([
      "signals",
      "admittedAtMs",
      "lastAtMs",
      "heartbeatAt",
      "confirmations",
      "waitingRef",
      "failureKind",
      "stoppedBy",
      "cards",
    ]);
    async function scripted(transportFlush: () => Promise<void>) {
      admit("run");
      emit("run", "start");
      approval("run", plugin("approval-0001"));
      approval("run", {
        phase: "resolved",
        kind: "plugin",
        status: "approved",
        approvalId: "approval-0001",
      });
      emit("run", "error", { error: "429 rate limit exceeded", fallbackExhaustedFailure: true });
      const before = stored();
      await transportFlush();
      return before;
    }

    it("with the switches off is the row the earlier build stored: no v2 key anywhere", async () => {
      flags.signals = false;
      flags.cards = false;
      const transport = install();
      const rows = await scripted(() => transport.flush());
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(Object.keys(row).filter((key) => newRowKeys.has(key))).toEqual([]);
      for (const fact of row.pending as Record<string, unknown>[]) {
        expect(Object.keys(fact).filter((key) => !baseFact.has(key))).toEqual([]);
      }
      expect((row.pending as unknown[]).length).toBe(5);
    });

    it("with the signals on keeps the facts as they were and puts the v2 fields beside them", async () => {
      flags.cards = false;
      const transport = install();
      const rows = await scripted(() => transport.flush());
      const row = rows[0]!;
      for (const fact of row.pending as Record<string, unknown>[]) {
        expect(Object.keys(fact).filter((key) => !baseFact.has(key))).toEqual([]);
      }
      const signals = row.signals as Record<string, Record<string, unknown>>;
      expect(Object.keys(signals).toSorted()).toEqual(
        (row.pending as { revision: number }[]).map((fact) => String(fact.revision)).toSorted(),
      );
      expect(row.admittedAtMs).toBe(T0);
    });
  });

  describe("decision cards", () => {
    it.for(["approve", "decline", "expire", "cancel", "no-route"] as const)(
      "projects the actual business approval owner and its %s settlement",
      async (outcome, testContext) => {
        vi.stubEnv("OPENCLAW_CONVERSATION_DECISION_CARDS", "true");
        const transport = install();
        admit("business-run");
        emit("business-run", "start");
        const fixture = createTestApprovalFixture<PluginApprovalRequestPayload>(testContext, {
          approvalKind: "plugin",
          resolveAllowedDecisions: (request) => request.allowedDecisions ?? ["allow-once", "deny"],
          onLifecycle: (event) => runtime.publish(event),
        });
        const runtime = createOperatorApprovalSessionEventRuntime({
          clients: [],
          sessionMessageSubscribers: { getApprovals: () => new Set<string>() },
          broadcastToConnIds: () => {},
          getLiveManager: () => fixture.manager,
        });
        await fixture.run(async () => {
          const record = fixture.manager.create(
            {
              pluginId: "billing",
              approvalOrigin: "plugin",
              conversation: {
                title: "Approve a payment",
                summary: "Pay 49.99 EUR to the supplier",
              },
              title: "Internal tool approval",
              description: "Internal execution diagnostics must stay off the card",
              allowedDecisions: ["allow-once", "deny"],
              agentId: binding.agentId,
              sessionKey: binding.sessionKey,
              sessionId: "session",
              runId: "business-run",
            },
            120_000,
            "plugin:business-request",
          );
          const { decision } = await fixture.manager.register(record, 120_000);
          await transport.flush();
          expect(cards).toHaveLength(1);
          expect(cards[0]!.content["ai.cellect.card"]).toMatchObject({
            id: record.id,
            status: "pending",
            revision: 1,
            title: "Approve a payment",
            summary: "Pay 49.99 EUR to the supplier",
            expiresAtMs: record.expiresAtMs,
            decisions: ["approve", "decline"],
          });
          expect(of("business-run").at(-1)?.waitingOn?.ref).toBe(record.id);
          if (outcome === "no-route") {
            await fixture.manager.expire(record.id, "no-approval-route");
          } else if (outcome === "expire") {
            clock = record.expiresAtMs;
            await fixture.manager.expire(record.id);
          } else if (outcome === "cancel") {
            await fixture.manager.forceDenyDetailed(
              record.id,
              "run-aborted",
              { kind: "system", id: "abort" },
              "cancelled",
            );
          } else {
            expect(
              await fixture.manager.resolve(
                record.id,
                outcome === "approve" ? "allow-once" : "deny",
              ),
            ).toBe(true);
            expect(
              await fixture.manager.resolve(
                record.id,
                outcome === "approve" ? "deny" : "allow-once",
              ),
            ).toBe(false);
          }
          await decision;
          await transport.flush();
          expect(cards).toHaveLength(2);
          expect(cards[1]!.content["ai.cellect.card"]).toMatchObject({
            id: record.id,
            revision: 2,
            status:
              outcome === "approve"
                ? "approved"
                : outcome === "decline"
                  ? "declined"
                  : outcome === "expire"
                    ? "expired"
                    : "cancelled",
            expiresAtMs: record.expiresAtMs,
            summary: "Pay 49.99 EUR to the supplier",
          });
          expect(of("business-run").at(-1)?.waitingOn).toBeUndefined();
        });
      },
    );

    it("offers only decline when the owner has no one-time approval choice", async () => {
      const transport = install();
      admit("run");
      approval(
        "run",
        plugin("plugin:decline-only", { allowedDecisions: ["allow-always", "deny"] }),
      );
      await transport.flush();
      expect(cards[0]!.content["ai.cellect.card"]).toMatchObject({ decisions: ["decline"] });
    });

    it("retains the approval's action and deadline when its binding appears later", async () => {
      let bound = false;
      const transport = install(() => (bound ? [binding] : []));
      admit("run");
      approval("run", plugin("plugin:late-binding"));
      bound = true;
      clock += 5_001;
      await transport.flush();
      expect(cards[0]!.content["ai.cellect.card"]).toMatchObject({
        id: "plugin:late-binding",
        expiresAtMs: T0 + 120_000,
        summary: "Pay 49.99 EUR to the supplier",
      });
    });

    it("opens a card when a person is asked and closes it when the answer comes", async () => {
      const transport = install();
      admit("run");
      emit("run", "start");
      approval("run", plugin("approval-0001"));
      await transport.flush();
      expect(cards).toHaveLength(1);
      const pending = cards[0]!.content["ai.cellect.card"] as {
        id: string;
        status: string;
        revision: number;
      };
      expect(isDecisionCard(pending)).toBe(true);
      expect(pending).toMatchObject({
        id: "approval-0001",
        status: "pending",
        revision: 1,
        kind: "confirmation",
      });
      expect(cards[0]!.content).toMatchObject({
        msgtype: "m.notice",
        "m.relates_to": { rel_type: "m.thread", event_id: "$root" },
      });
      // Sent once.
      await transport.flush();
      expect(cards).toHaveLength(1);
      approval("run", {
        phase: "resolved",
        kind: "plugin",
        status: "denied",
        approvalId: "approval-0001",
      });
      await transport.flush();
      expect(cards).toHaveLength(2);
      expect(cards[1]!.content["ai.cellect.card"]).toMatchObject({
        status: "declined",
        revision: 2,
      });
      expect(isDecisionCard(cards[1]!.content["ai.cellect.card"])).toBe(true);
      expect(new Set(cards.map((card) => card.transactionId)).size).toBe(2);
    });

    it("cancels a card whose run ended before anyone answered", async () => {
      const transport = install();
      admit("run");
      emit("run", "start");
      approval("run", plugin("approval-0001"));
      await transport.flush();
      emit("run", "end", { aborted: true });
      await transport.flush();
      expect(cards.at(-1)!.content["ai.cellect.card"]).toMatchObject({
        status: "cancelled",
        revision: 2,
      });
    });

    it("is never recorded or sent while the switch is off", async () => {
      flags.cards = false;
      const transport = install();
      admit("run");
      emit("run", "start");
      approval("run", plugin("approval-0001"));
      await transport.flush();
      expect(cards).toEqual([]);
    });

    it("never holds the run's status back when a card cannot be sent, and retries on its own backoff", async () => {
      failCards = true;
      const transport = install();
      admit("run");
      emit("run", "start");
      approval("run", plugin("approval-0001"));
      await transport.flush();
      expect(states("run")).toEqual(["queued", "running", "waiting"]);
      expect(cards).toEqual([]);
      expect(errors).toEqual([{ roomId: binding.roomId, reason: "delivery_failed", failures: 1 }]);
      await transport.flush();
      expect(errors).toHaveLength(1);
      failCards = false;
      clock = T0 + 10_000;
      await transport.flush();
      expect(cards).toHaveLength(1);
    });

    it("sends nothing about an approval a person cannot decide here", async () => {
      const transport = install();
      // A command, a change to the gateway, an unknown kind, and the Codex bridge's file
      // and permission approvals, which are labelled "plugin" and carry no marker.
      const refused: [string, Record<string, unknown>][] = [
        ["exec", { ...plugin("approval-x"), kind: "exec" }],
        ["system", { ...plugin("approval-y"), kind: "system-agent" }],
        ["unknown", { ...plugin("approval-z"), kind: "unknown" }],
        ["codex", { ...plugin("approval-c"), chatDecidable: undefined }],
      ];
      for (const [id, data] of refused) {
        admit(id);
        emit(id, "start");
        approval(id, data);
      }
      await transport.flush();
      expect(cards).toEqual([]);
      for (const [id] of refused) {
        expect(of(id).at(-1)).toMatchObject({ state: "waiting" });
        expect(of(id).at(-1)!.waitingOn).toBeUndefined();
      }
    });

    it("sends the answer even when the result lands before the first flush", async () => {
      const transport = install();
      admit("run");
      emit("run", "start");
      approval("run", plugin("approval-0001"));
      approval("run", {
        phase: "resolved",
        kind: "plugin",
        status: "approved",
        approvalId: "approval-0001",
      });
      emit("run", "end");
      transport.noteResult({
        runId: "run",
        generation: getAgentRunLifecycleGeneration(),
        bindingId: binding.bindingId,
        resultEventId: "$result",
      });
      await transport.flush();
      expect(states("run").at(-1)).toBe("completed");
      expect(
        cards.map((card) => (card.content["ai.cellect.card"] as { status: string }).status),
      ).toEqual(["approved"]);
      await transport.flush();
      expect(cards).toHaveLength(1);
      // Every card is sent, so the row is complete and no longer pending.
      expect(stored()).toEqual([]);
    });

    it("holds a settled row until its card is sent, then completes it", async () => {
      failCards = true;
      const transport = install();
      admit("run");
      emit("run", "start");
      approval("run", plugin("approval-0001"));
      approval("run", {
        phase: "resolved",
        kind: "plugin",
        status: "denied",
        approvalId: "approval-0001",
      });
      emit("run", "end");
      transport.noteResult({
        runId: "run",
        generation: getAgentRunLifecycleGeneration(),
        bindingId: binding.bindingId,
        resultEventId: "$result",
      });
      await transport.flush();
      expect(states("run").at(-1)).toBe("completed");
      expect(cards).toEqual([]);
      expect(stored()).toHaveLength(1);
      failCards = false;
      clock = T0 + 10_000;
      await transport.flush();
      expect(cards).toHaveLength(1);
      expect(cards[0]!.content["ai.cellect.card"]).toMatchObject({
        status: "declined",
        revision: 2,
      });
      expect(stored()).toEqual([]);
    });

    it("gives up a settled row's cards when the switch is off, so the row can complete", async () => {
      failCards = true;
      const transport = install();
      admit("run");
      emit("run", "start");
      approval("run", plugin("approval-0001"));
      emit("run", "end");
      transport.noteResult({
        runId: "run",
        generation: getAgentRunLifecycleGeneration(),
        bindingId: binding.bindingId,
        resultEventId: "$result",
      });
      await transport.flush();
      expect(stored()).toHaveLength(1);
      flags.cards = false;
      clock = T0 + 10_000;
      await transport.flush();
      expect(stored()).toEqual([]);
      expect(cards).toEqual([]);
    });

    it("gives up a card the room refuses for good once it is well past expiry, so the row completes", async () => {
      failCards = true;
      const transport = install();
      admit("run");
      emit("run", "start");
      approval("run", plugin("approval-0001"));
      emit("run", "end");
      transport.noteResult({
        runId: "run",
        generation: getAgentRunLifecycleGeneration(),
        bindingId: binding.bindingId,
        resultEventId: "$result",
      });
      await transport.flush();
      expect(stored()).toHaveLength(1);
      // The card said it could be decided for 30 minutes; the room is given an hour more.
      clock = T0 + 89 * 60_000;
      await transport.flush();
      expect(stored()).toHaveLength(1);
      clock = T0 + 91 * 60_000;
      await transport.flush();
      expect(stored()).toEqual([]);
      expect(cards).toEqual([]);
    });

    it("cancels an open card when the run is reported interrupted instead", async () => {
      const transport = install();
      admit("lost");
      emit("lost", "start");
      approval("lost", plugin("approval-0001"));
      await transport.flush();
      expect(cards).toHaveLength(1);
      // The executor is gone: the context is swept, and after the hold the run is interrupted.
      clock = T0 + 31 * 60_000;
      expect(sweepStaleRunContexts()).toBe(1);
      await transport.flush();
      clock = T0 + 62 * 60_000;
      await transport.flush();
      expect(of("lost").at(-1)!.state).toBe("interrupted");
      expect(cards.at(-1)!.content["ai.cellect.card"]).toMatchObject({
        status: "cancelled",
        revision: 2,
      });
    });
  });

  it("emits a run the consumer reads end to end, and matches the recorded golden facts", async () => {
    const transport = install();
    const run = (id: string) => {
      admit(id);
    };
    // One run through a confirmation, a heartbeat while it waits and after, and a failure.
    clock = T0;
    run("run-0001");
    clock = T0 + 1_000;
    emit("run-0001", "start");
    clock = T0 + 2_000;
    approval("run-0001", plugin("approval-0001"));
    await transport.flush();
    clock = T0 + 70_000;
    await transport.flush();
    clock = T0 + 80_000;
    approval("run-0001", {
      phase: "resolved",
      kind: "plugin",
      status: "approved",
      approvalId: "approval-0001",
    });
    await transport.flush();
    clock = T0 + 150_000;
    await transport.flush();
    clock = T0 + 215_000;
    await transport.flush();
    clock = T0 + 221_000;
    emit("run-0001", "error", { error: "429 rate limit exceeded", fallbackExhaustedFailure: true });
    // One run replaced by a newer writer, one that completes.
    clock = T0 + 5_000;
    run("run-0002");
    emit("run-0002", "start");
    emit("run-0002", "end", { aborted: true, stopReason: "superseded" });
    run("run-0003");
    emit("run-0003", "start");
    emit("run-0003", "end");
    clock = T0 + 222_000;
    await transport.flush();
    transport.noteResult({
      runId: "run-0003",
      generation: getAgentRunLifecycleGeneration(),
      bindingId: binding.bindingId,
      resultEventId: "$result-0003",
    });
    await transport.flush();
    for (const id of ["run-0001", "run-0002", "run-0003"]) {
      consume(id);
    }

    const generation = getAgentRunLifecycleGeneration();
    // Rows with the same enqueue time are sent in no fixed order across runs; within a run revisions are in order.
    const normalized = facts
      .map(
        (fact) =>
          Object.fromEntries(
            Object.entries(fact).map(([key, value]) => [
              key,
              key === "generation" && value === generation ? "generation-opaque-0001" : value,
            ]),
          ) as unknown as ConversationLifecyclePublication,
      )
      .toSorted((a, b) => a.runId.localeCompare(b.runId) || a.revision - b.revision);
    const golden = {
      note: "Facts and business decision cards emitted with both switches on. Written by conversation-lifecycle.signals.test.ts (UPDATE_GATEWAY_EMITTED_FIXTURE=1). Canonical approval owner publication is covered separately by the business approval flow tests.",
      facts: normalized,
      heartbeats: normalized
        .map((fact, i) => {
          const previous = normalized.slice(0, i).findLast((p) => p.runId === fact.runId);
          return previous && isRunHeartbeat(previous as never, fact as never) ? i : -1;
        })
        .filter((i) => i >= 0),
      cards: cards.map((card) => card.content["ai.cellect.card"]),
    };
    expect(golden.heartbeats.length).toBeGreaterThanOrEqual(3);
    const recorded = `${JSON.stringify(golden, null, 2)}\n`;
    if (process.env.UPDATE_GATEWAY_EMITTED_FIXTURE === "1") {
      fs.writeFileSync(GOLDEN, recorded);
    }
    // Without the file the facts are printed, so a run on a builder can be recorded from its log.
    if (!fs.existsSync(GOLDEN)) {
      console.log(`GOLDEN-BEGIN\n${recorded}GOLDEN-END`);
    }
    expect(golden).toEqual(JSON.parse(fs.readFileSync(GOLDEN, "utf8")));
  });
});
