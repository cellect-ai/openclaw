import { describe, expect, it } from "vitest";
import {
  hookRequesterScopeAllowed,
  isShadowHookSessionKey,
  isPersonalReviewHookSessionKey,
  lookupHookRequesterAttestation,
  normalizeHookRequesterAttestation,
  registerHookRequesterAttestation,
} from "./hook-requester-attestation.js";

const ATTESTATION = `fsa:job-1:${"A".repeat(43)}`;
const SHADOW = "agent:cellect-fi-user:hook:fi-shadow:abc";
const REVIEW = `hook:fi-review:${"a".repeat(40)}`;
const REVIEW_ATTESTATION = `pra:job-1:${"B".repeat(43)}`;

describe("personal review purpose isolation", () => {
  it("transports a review grant only in its exact active review run", () => {
    expect(isPersonalReviewHookSessionKey(REVIEW)).toBe(true);
    expect(
      normalizeHookRequesterAttestation({ requesterAttestation: REVIEW_ATTESTATION }, REVIEW),
    ).toEqual({
      ok: true,
      value: { requesterAttestation: REVIEW_ATTESTATION },
    });
    const release = registerHookRequesterAttestation({
      runId: "review-1",
      sessionKey: REVIEW,
      attestation: REVIEW_ATTESTATION,
    });
    expect(lookupHookRequesterAttestation("review-1", REVIEW)).toBe(REVIEW_ATTESTATION);
    expect(lookupHookRequesterAttestation("other", REVIEW)).toBeUndefined();
    expect(lookupHookRequesterAttestation("review-1", SHADOW)).toBeUndefined();
    release();
    expect(lookupHookRequesterAttestation("review-1", REVIEW)).toBeUndefined();
  });
  it("refuses swapped purposes, delivery knobs, and non-user review sessions", () => {
    expect(
      hookRequesterScopeAllowed(
        { requesterAttestation: REVIEW_ATTESTATION, effectiveAgentId: "cellect-fi-user" },
        REVIEW,
      ),
    ).toBe(true);
    expect(
      hookRequesterScopeAllowed(
        { requesterAttestation: REVIEW_ATTESTATION, effectiveAgentId: "cellect-fi-admin" },
        REVIEW,
      ),
    ).toBe(false);
    for (const [sessionKey, requesterAttestation] of [
      [REVIEW, ATTESTATION],
      [SHADOW, REVIEW_ATTESTATION],
      [REVIEW.replace("fi-review", "fi-shadow"), REVIEW_ATTESTATION],
      [REVIEW.replace("hook:", "agent:other:hook:"), REVIEW_ATTESTATION],
    ]) {
      expect(normalizeHookRequesterAttestation({ requesterAttestation }, sessionKey).ok).toBe(
        false,
      );
      registerHookRequesterAttestation({
        runId: "wrong-purpose",
        sessionKey,
        attestation: requesterAttestation,
      });
      expect(lookupHookRequesterAttestation("wrong-purpose", sessionKey)).toBeUndefined();
    }
    expect(
      normalizeHookRequesterAttestation(
        { requesterAttestation: REVIEW_ATTESTATION, deliver: true },
        REVIEW,
      ).ok,
    ).toBe(false);
    expect(normalizeHookRequesterAttestation({}, REVIEW).ok).toBe(false);
  });
});

describe("hook requester attestation run context", () => {
  it("is readable for exactly the registered run and session until released", () => {
    const release = registerHookRequesterAttestation({
      runId: "run-1",
      sessionKey: SHADOW,
      attestation: ATTESTATION,
    });
    expect(lookupHookRequesterAttestation("run-1", SHADOW)).toBe(ATTESTATION);
    expect(lookupHookRequesterAttestation("run-2", SHADOW)).toBeUndefined();
    expect(
      lookupHookRequesterAttestation("run-1", "agent:cellect-fi-user:hook:fi-shadow:other"),
    ).toBeUndefined();
    release();
    expect(lookupHookRequesterAttestation("run-1", SHADOW)).toBeUndefined();
  });

  it("records nothing for a non-shadow session or a malformed value", () => {
    for (const [sessionKey, attestation] of [
      ["agent:cellect-fi-user:hook:fi-mail:abc", ATTESTATION],
      ["agent:cellect-fi-user:cron:job", ATTESTATION],
      [SHADOW, "fsa:x:short"],
      [SHADOW, undefined],
    ] as const) {
      registerHookRequesterAttestation({ runId: "run-3", sessionKey, attestation });
      expect(lookupHookRequesterAttestation("run-3", sessionKey)).toBeUndefined();
    }
  });
});

describe("shadow hook ingress delivery knobs", () => {
  it.each([
    ["deliver", { deliver: true }],
    ["channel", { channel: "slack" }],
    ["to", { to: "u1" }],
    ["accountId", { accountId: "work" }],
    ["allowUnsafeExternalContent", { allowUnsafeExternalContent: true }],
  ])("rejects %s on a shadow session", (name, extra) => {
    expect(
      normalizeHookRequesterAttestation(
        { requesterAttestation: ATTESTATION, ...extra },
        "hook:fi-shadow:abc",
      ),
    ).toEqual({ ok: false, error: `${name} is not accepted on a hook:fi-shadow: session` });
  });

  it("accepts the quiet form and leaves other sessions alone", () => {
    expect(
      normalizeHookRequesterAttestation(
        { requesterAttestation: ATTESTATION, deliver: false, allowUnsafeExternalContent: false },
        "hook:fi-shadow:abc",
      ),
    ).toEqual({ ok: true, value: { requesterAttestation: ATTESTATION } });
    expect(
      normalizeHookRequesterAttestation({ deliver: true, channel: "slack" }, "hook:fi-mail:abc"),
    ).toEqual({ ok: true, value: {} });
  });
});

describe("shadow session predicate", () => {
  it.each([
    ["hook:fi-shadow:abc", true],
    ["agent:cellect-fi-user:hook:fi-shadow:abc", true],
    ["AGENT:cellect-fi-user:HOOK:FI-SHADOW:abc", true],
    ["hook:fi-mail:abc", false],
    ["agent:main:xhook:fi-shadow:abc", false],
    [undefined, false],
  ])("%s -> %s", (key, expected) => {
    expect(isShadowHookSessionKey(key)).toBe(expected);
  });

  it("treats the agent-qualified form like the bare one at ingress", () => {
    const qualified = "agent:cellect-fi-user:hook:fi-shadow:abc";
    expect(
      normalizeHookRequesterAttestation({ requesterAttestation: ATTESTATION }, qualified),
    ).toEqual({
      ok: true,
      value: { requesterAttestation: ATTESTATION },
    });
    expect(normalizeHookRequesterAttestation({}, qualified)).toMatchObject({ ok: false });
  });

  it("rejects channel last at ingress even though the dispatcher tolerates it with delivery none", () => {
    expect(
      normalizeHookRequesterAttestation(
        { requesterAttestation: ATTESTATION, channel: "last" },
        "hook:fi-shadow:abc",
      ),
    ).toEqual({ ok: false, error: "channel is not accepted on a hook:fi-shadow: session" });
  });
});
