import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyAgentRunTerminalOutcome } from "@openclaw/normalization-core/agent-run-terminal-outcome";
import { describe, expect, it } from "vitest";
import { resolveChatErrorKindFromError } from "../gateway/server-chat.js";
import {
  buildConfirmationCard,
  CHAT_DECIDABLE_APPROVAL_KINDS,
  decisionCardContent,
  decisionCardsEnabled,
  factForSend,
  failureKindOf,
  lifecycleSignalsEnabled,
  nextAtMs,
  stoppedByOf,
  waitingOnOf,
  type LifecycleSignals,
} from "./conversation-lifecycle-signals.js";
import {
  baseRunLifecycle,
  isDecisionCard,
  isRunHeartbeat,
  parseRunLifecycle,
  reduceRunLifecycle,
  type RunLifecycle,
} from "./test-fixtures/cellect-threads/kit-contract.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, "test-fixtures/cellect-threads");
const read = (name: string) => fs.readFileSync(path.join(fixtureDir, name));
const lifecycle = JSON.parse(read("conversation-lifecycle-signals-v2.json").toString());
const decision = JSON.parse(read("decision-card-v1.json").toString());

describe("the vendored cellect-threads fixtures", () => {
  const source = JSON.parse(read("SOURCE.json").toString()) as {
    commit: string;
    sha256: Record<string, string>;
  };
  it("are the files the record names", () => {
    expect(source.commit).toMatch(/^[0-9a-f]{40}$/);
    for (const [name, sum] of Object.entries(source.sha256)) {
      expect(createHash("sha256").update(read(name)).digest("hex"), name).toBe(sum);
    }
  });
  // Set CELLECT_THREADS_DIR to a cellect-threads checkout to prove the copies are not stale.
  it.skipIf(!process.env.CELLECT_THREADS_DIR)("equal the kit's files in the checkout", () => {
    for (const name of Object.keys(source.sha256)) {
      expect(
        read(name).equals(
          fs.readFileSync(path.join(process.env.CELLECT_THREADS_DIR!, "kit/fixtures", name)),
        ),
      ).toBe(true);
    }
  });
});

describe("the consumer port is held to the shared fixtures", () => {
  it("accepts every positive lifecycle fact", () => {
    for (const value of lifecycle.positive) {
      expect(parseRunLifecycle(value)).toEqual(value);
    }
  });
  it("rejects every negative lifecycle fact", () => {
    for (const test of lifecycle.negative) {
      expect(() => parseRunLifecycle(test.value), test.name).toThrow();
    }
  });
  it("reproduces every reduction", () => {
    for (const test of lifecycle.reduce) {
      const run = () => {
        let state: RunLifecycle | null = null;
        const beats: boolean[] = [];
        for (const [i, fact] of test.facts.entries()) {
          if (state) {
            beats.push(isRunHeartbeat(state, fact));
          }
          state = reduceRunLifecycle(
            state,
            fact,
            test.receivedAtMs ? { receivedAtMs: test.receivedAtMs[i] } : undefined,
          );
        }
        return { state, beats };
      };
      if (test.error) {
        expect(run, test.name).toThrow(test.error);
        continue;
      }
      const { state, beats } = run();
      expect(state, test.name).toEqual(test.result);
      expect(beats, test.name).toEqual(test.heartbeat);
    }
  });
  it("accepts every positive decision card and rejects every negative one", () => {
    for (const card of decision.positive) {
      expect(isDecisionCard(card)).toBe(true);
    }
    for (const test of decision.negative) {
      expect(isDecisionCard(test.value), test.name).toBe(false);
    }
  });
});

describe("what the gateway sends", () => {
  it("with the flag off, is every positive fixture as the 2026-09-18 contract knew it", () => {
    for (const fact of lifecycle.positive as RunLifecycle[]) {
      const sent = factForSend(fact as never, { signals: false, decisionCards: true });
      expect(sent).toEqual(baseRunLifecycle(fact));
      expect(
        Object.keys(sent).some((key) =>
          ["atMs", "admittedAtMs", "waitingOn", "failureKind", "stoppedBy"].includes(key),
        ),
      ).toBe(false);
    }
  });

  it("with the flag on, keeps every valid signal, and only the person's id is withheld", () => {
    for (const fact of lifecycle.positive as RunLifecycle[]) {
      const sent = factForSend(fact as never, {
        signals: true,
        decisionCards: true,
      }) as RunLifecycle;
      expect(() => parseRunLifecycle(sent)).not.toThrow();
      const expected = structuredClone(fact);
      if (expected.stoppedBy) {
        expected.stoppedBy = { kind: expected.stoppedBy.kind };
      }
      expect(sent).toEqual(expected);
    }
  });

  it("never sends a signal the consumer would reject the fact for", () => {
    const known = new Set([
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
      "atMs",
      "admittedAtMs",
      "waitingOn",
      "failureKind",
      "stoppedBy",
    ]);
    let checked = 0;
    for (const test of lifecycle.negative) {
      // A key that is no signal and no part of the fact is not this function's to judge.
      if (Object.keys(test.value).some((key) => !known.has(key))) {
        continue;
      }
      checked += 1;
      expect(
        () => parseRunLifecycle(factForSend(test.value, { signals: true, decisionCards: true })),
        test.name,
      ).not.toThrow();
    }
    expect(checked).toBeGreaterThan(35);
  });

  it("names no decision card that will not exist", () => {
    const waiting = {
      ...lifecycle.positive.find((fact: RunLifecycle) => fact.waitingOn?.kind === "confirmation"),
      atMs: 1_789_718_401_000,
    };
    const off = factForSend(waiting, { signals: true, decisionCards: false }) as RunLifecycle;
    expect(off.waitingOn).toBeUndefined();
    // The rest of the signals still go.
    expect(off.atMs).toBe(1_789_718_401_000);
    const question = lifecycle.positive.find(
      (fact: RunLifecycle) => fact.waitingOn?.kind === "question",
    );
    expect(
      (factForSend(question, { signals: true, decisionCards: false }) as RunLifecycle).waitingOn,
    ).toEqual(question.waitingOn);
  });

  it("drops a signal on a state it does not describe instead of sending it", () => {
    const signals: LifecycleSignals = {
      waitingOn: { kind: "confirmation", ref: "a-1" },
      failureKind: "timeout",
      stoppedBy: { kind: "person" },
      atMs: 1_789_718_400_000,
    };
    expect(
      factForSend({ state: "running", ...signals }, { signals: true, decisionCards: true }),
    ).toEqual({ state: "running", atMs: 1_789_718_400_000 });
    expect(
      factForSend({ state: "failed", ...signals }, { signals: true, decisionCards: true }),
    ).toEqual({
      state: "failed",
      atMs: 1_789_718_400_000,
      failureKind: "timeout",
    });
    expect(
      factForSend({ state: "cancelled", ...signals }, { signals: true, decisionCards: true }),
    ).toEqual({
      state: "cancelled",
      atMs: 1_789_718_400_000,
      stoppedBy: { kind: "person" },
    });
    expect(
      factForSend(
        { state: "running", atMs: 1_789_718_400, admittedAtMs: 1e13 },
        { signals: true, decisionCards: true },
      ),
    ).toEqual({ state: "running" });
    expect(
      factForSend(
        { state: "waiting", waitingOn: { kind: "confirmation", ref: "has space" } },
        { signals: true, decisionCards: true },
      ),
    ).toEqual({ state: "waiting" });
  });

  it("keeps the producer's clock strictly forward", () => {
    expect(nextAtMs(1_789_718_400_000, undefined)).toBe(1_789_718_400_000);
    expect(nextAtMs(1_789_718_400_000, 1_789_718_400_000)).toBe(1_789_718_400_001);
    expect(nextAtMs(1_789_718_400_000, 1_789_718_500_000)).toBe(1_789_718_500_001);
    expect(nextAtMs(1_789_718_400, undefined)).toBeUndefined();
  });

  it("reads the switches from the environment, off unless set", () => {
    expect(lifecycleSignalsEnabled({})).toBe(false);
    expect(lifecycleSignalsEnabled({ OPENCLAW_CONVERSATION_LIFECYCLE_SIGNALS: "1" })).toBe(true);
    expect(lifecycleSignalsEnabled({ OPENCLAW_CONVERSATION_LIFECYCLE_SIGNALS: "off" })).toBe(false);
    expect(decisionCardsEnabled({})).toBe(false);
    expect(decisionCardsEnabled({ OPENCLAW_CONVERSATION_DECISION_CARDS: "true" })).toBe(true);
    // One switch does not turn on the other.
    expect(decisionCardsEnabled({ OPENCLAW_CONVERSATION_LIFECYCLE_SIGNALS: "1" })).toBe(false);
  });
});

describe("failure, stopper and wait", () => {
  it("classifies a failure exactly as the chat stream does, from the same inputs", () => {
    const errors: unknown[] = [
      new Error("429 rate limit exceeded"),
      new Error("The model is overloaded, try again later"),
      new Error("context length exceeded: prompt is too long"),
      new Error("Unhandled stop reason: refusal_policy"),
      new Error("content_filter triggered"),
      Object.assign(new Error("request timed out"), { name: "TimeoutError" }),
      new Error("something unexpected happened"),
      "plain string failure",
      undefined,
    ];
    // The stream's own formula: a recorded timeout classification, then the event's
    // errorKind (the kinds it knows), then what `data.error` says.
    const streamKinds = new Set(["refusal", "timeout", "rate_limit", "context_length", "unknown"]);
    const chat = (reason: string, data: { errorKind?: unknown; error?: unknown }) =>
      classifyAgentRunTerminalOutcome({ reason } as never) === "timeout"
        ? "timeout"
        : ((typeof data.errorKind === "string" && streamKinds.has(data.errorKind)
            ? data.errorKind
            : undefined) ??
          resolveChatErrorKindFromError(data.error) ??
          "unknown");
    for (const reason of ["failed", "timed_out"]) {
      for (const error of errors) {
        for (const errorKind of [undefined, "rate_limit", "nonsense"]) {
          expect(
            failureKindOf({ reason } as never, { error, errorKind }),
            `${reason} ${String(error)} ${String(errorKind)}`,
          ).toBe(chat(reason, { error, errorKind }));
        }
      }
    }
    // The one kind the stream does not read from the event: contention, which a fact carries.
    expect(failureKindOf({ reason: "failed" } as never, { errorKind: "state_contention" })).toBe(
      "state_contention",
    );
  });

  it("allows only plugin approvals, by name", () => {
    expect(CHAT_DECIDABLE_APPROVAL_KINDS).toEqual(["plugin"]);
  });

  it("names the coordinator for a superseded run and nobody otherwise", () => {
    expect(stoppedByOf("superseded")).toEqual({ kind: "coordinator" });
    expect(stoppedByOf("aborted")).toBeUndefined();
    expect(stoppedByOf("cancelled")).toBeUndefined();
    expect(stoppedByOf(undefined)).toBeUndefined();
  });

  it("names the first open approval a person may decide, and nothing for a command", () => {
    expect(waitingOnOf(["exec-1", "plugin-1", "plugin-2"], ["plugin-1", "plugin-2"])).toEqual({
      kind: "confirmation",
      ref: "plugin-1",
    });
    expect(waitingOnOf(["exec-1"], ["plugin-1"])).toBeUndefined();
    expect(waitingOnOf(["plugin 1"], ["plugin 1"])).toBeUndefined();
    expect(waitingOnOf([], undefined)).toBeUndefined();
  });
});

describe("the confirmation card", () => {
  const expiresAtMs = 1_789_719_000_000;
  const business = {
    conversation: { title: "Approve a payment", summary: "Pay 49.99 EUR to the supplier" },
    decisions: ["approve", "decline"] as const,
  };
  it("is a decision card the contract accepts, in every status", () => {
    for (const status of [
      "pending",
      "approved",
      "declined",
      "expired",
      "superseded",
      "cancelled",
    ] as const) {
      const card = buildConfirmationCard({
        ...business,
        id: "approval-1",
        revision: 1,
        status,
        runId: "run-1",
        expiresAtMs,
      });
      expect(isDecisionCard(card), status).toBe(true);
    }
  });
  it("uses the owner business intent and offers approve and decline only", () => {
    const card = buildConfirmationCard({
      ...business,
      id: "approval-1",
      revision: 1,
      status: "pending",
      runId: "run-1",
      expiresAtMs,
    })!;
    expect(card.decisions).toEqual(["approve", "decline"]);
    expect(card.kind).toBe("confirmation");
    expect(card.title).toBe(business.conversation.title);
    expect(card.summary).toBe(business.conversation.summary);
    expect(Object.keys(card).toSorted()).toEqual(
      [
        "decisions",
        "expiresAtMs",
        "id",
        "kind",
        "revision",
        "runId",
        "status",
        "summary",
        "title",
        "type",
        "version",
      ].toSorted(),
    );
  });
  it("is refused rather than sent when it would be invalid", () => {
    expect(
      buildConfirmationCard({
        ...business,
        id: "has space",
        revision: 1,
        status: "pending",
        runId: "r",
        expiresAtMs,
      }),
    ).toBeUndefined();
    expect(
      buildConfirmationCard({
        ...business,
        id: "ok",
        revision: 0,
        status: "pending",
        runId: "r",
        expiresAtMs,
      }),
    ).toBeUndefined();
    expect(
      buildConfirmationCard({
        ...business,
        id: "ok",
        revision: 1,
        status: "pending",
        runId: "r",
        expiresAtMs: 1,
      }),
    ).toBeUndefined();
  });
  it("travels in the card envelope of a notice, in the run's thread", () => {
    const card = buildConfirmationCard({
      ...business,
      id: "approval-1",
      revision: 1,
      status: "pending",
      runId: "run-1",
      expiresAtMs,
    })!;
    const content = decisionCardContent(card, "$root");
    expect(content).toMatchObject({
      msgtype: "m.notice",
      "ai.cellect.card": card,
      "m.relates_to": { rel_type: "m.thread", event_id: "$root" },
    });
    expect(typeof content.body).toBe("string");
    expect(decisionCardContent(card, undefined)["m.relates_to"]).toBeUndefined();
  });
});
