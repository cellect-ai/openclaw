import { describe, expect, it } from "vitest";
import {
  hookRequesterScopeAllowed,
  isGuestHookSessionKey,
  isShadowHookSessionKey,
  isPersonalReviewHookSessionKey,
  lookupHookRequesterAttestation,
  lookupHookRequesterEnvironment,
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
        {
          requesterAttestation: REVIEW_ATTESTATION,
          effectiveAgentId: "cellect-fi-user",
        },
        REVIEW,
      ),
    ).toBe(true);
    expect(
      hookRequesterScopeAllowed(
        {
          requesterAttestation: REVIEW_ATTESTATION,
          effectiveAgentId: "cellect-fi-admin",
        },
        REVIEW,
      ),
    ).toBe(true);
    expect(
      hookRequesterScopeAllowed(
        {
          requesterAttestation: REVIEW_ATTESTATION,
          effectiveAgentId: "cellect-main",
        },
        REVIEW,
      ),
    ).toBe(false);
    expect(
      hookRequesterScopeAllowed(
        { requesterAttestation: REVIEW_ATTESTATION, effectiveAgentId: "other" },
        REVIEW,
      ),
    ).toBe(false);
    expect(
      isPersonalReviewHookSessionKey(REVIEW.replace("hook:", "agent:cellect-fi-admin:hook:")),
    ).toBe(true);
    expect(isPersonalReviewHookSessionKey(REVIEW.replace("hook:", "agent:other:hook:"))).toBe(
      false,
    );
    for (const [sessionKey, requesterAttestation] of [
      [REVIEW, ATTESTATION],
      [SHADOW, REVIEW_ATTESTATION],
      [REVIEW.replace("fi-review", "fi-shadow"), REVIEW_ATTESTATION],
      [REVIEW.replace("hook:", "agent:other:hook:"), REVIEW_ATTESTATION],
    ] as const) {
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

it("carries optional authenticated mail environment while preserving the missing-field compatibility floor", () => {
  expect(
    normalizeHookRequesterAttestation({ requesterEnvironment: "dev" }, "hook:fi-mail:source"),
  ).toEqual({ ok: true, value: { requesterEnvironment: "dev" } });
  expect(normalizeHookRequesterAttestation({}, "hook:fi-mail:source")).toEqual({
    ok: true,
    value: {},
  });
  expect(
    normalizeHookRequesterAttestation({ requesterEnvironment: "invented" }, "hook:fi-mail:source")
      .ok,
  ).toBe(false);
  expect(
    normalizeHookRequesterAttestation({ requesterEnvironment: "prod" }, "hook:unrelated:source").ok,
  ).toBe(false);
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
      registerHookRequesterAttestation({
        runId: "run-3",
        sessionKey,
        attestation,
      });
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
    ).toEqual({
      ok: false,
      error: `${name} is not accepted on a hook:fi-shadow: session`,
    });
  });

  it("accepts the quiet form and leaves other sessions alone", () => {
    expect(
      normalizeHookRequesterAttestation(
        {
          requesterAttestation: ATTESTATION,
          deliver: false,
          allowUnsafeExternalContent: false,
        },
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
    expect(normalizeHookRequesterAttestation({}, qualified)).toMatchObject({
      ok: false,
    });
  });

  it("rejects channel last at ingress even though the dispatcher tolerates it with delivery none", () => {
    expect(
      normalizeHookRequesterAttestation(
        { requesterAttestation: ATTESTATION, channel: "last" },
        "hook:fi-shadow:abc",
      ),
    ).toEqual({
      ok: false,
      error: "channel is not accepted on a hook:fi-shadow: session",
    });
  });
});

describe("guest conversation purpose isolation", () => {
  const GUEST = `hook:fi-guest:${"a".repeat(40)}`;
  const GUEST_ATTESTATION = `fga:gt_1:${"C".repeat(43)}`;

  it("transports a guest receipt only on a guest session", () => {
    expect(isGuestHookSessionKey(GUEST)).toBe(true);
    expect(isGuestHookSessionKey(`agent:cellect-fi-guest:${GUEST}`)).toBe(true);
    expect(
      normalizeHookRequesterAttestation(
        {
          requesterAttestation: GUEST_ATTESTATION,
          requesterEnvironment: "dev",
        },
        GUEST,
      ),
    ).toEqual({
      ok: true,
      value: {
        requesterAttestation: GUEST_ATTESTATION,
        requesterEnvironment: "dev",
      },
    });
    const release = registerHookRequesterAttestation({
      runId: "guest-1",
      sessionKey: GUEST,
      attestation: GUEST_ATTESTATION,
      environment: "dev",
    });
    expect(lookupHookRequesterAttestation("guest-1", GUEST)).toBe(GUEST_ATTESTATION);
    expect(lookupHookRequesterEnvironment("guest-1", GUEST)).toBe("dev");
    expect(lookupHookRequesterAttestation("guest-1", SHADOW)).toBeUndefined();
    release();
    expect(lookupHookRequesterAttestation("guest-1", GUEST)).toBeUndefined();
  });

  it("refuses a guest receipt on any other namespace and other receipts on a guest session", () => {
    for (const [sessionKey, requesterAttestation] of [
      [SHADOW, GUEST_ATTESTATION],
      [REVIEW, GUEST_ATTESTATION],
      ["hook:fi-mail:abc", GUEST_ATTESTATION],
      ["hook:other:abc", GUEST_ATTESTATION],
      [GUEST, ATTESTATION],
      [GUEST, REVIEW_ATTESTATION],
      [GUEST.replace("fi-guest", "fi-shadow"), GUEST_ATTESTATION],
    ]) {
      expect(normalizeHookRequesterAttestation({ requesterAttestation }, sessionKey).ok).toBe(
        false,
      );
    }
    expect(normalizeHookRequesterAttestation({}, GUEST).ok).toBe(false);
    expect(normalizeHookRequesterAttestation({}, undefined)).toEqual({
      ok: true,
      value: {},
    });
    registerHookRequesterAttestation({
      runId: "wrong",
      sessionKey: SHADOW,
      attestation: GUEST_ATTESTATION,
    });
    expect(lookupHookRequesterAttestation("wrong", SHADOW)).toBeUndefined();
  });

  it("refuses delivery knobs and requires a named environment on a guest session", () => {
    for (const extra of [
      { requesterEnvironment: "dev", deliver: true },
      { requesterEnvironment: "dev", channel: "slack" },
      { requesterEnvironment: "dev", to: "x" },
      { requesterEnvironment: "dev", allowUnsafeExternalContent: true },
      {},
      { requesterEnvironment: "qa" },
      { requesterEnvironment: 1 },
    ]) {
      expect(
        normalizeHookRequesterAttestation(
          { requesterAttestation: GUEST_ATTESTATION, ...extra },
          GUEST,
        ).ok,
      ).toBe(false);
    }
    // A guest run without a named environment carries no attestation at all.
    registerHookRequesterAttestation({
      runId: "guest-no-env",
      sessionKey: GUEST,
      attestation: GUEST_ATTESTATION,
    });
    expect(lookupHookRequesterAttestation("guest-no-env", GUEST)).toBeUndefined();
    expect(
      hookRequesterScopeAllowed(
        {
          requesterAttestation: GUEST_ATTESTATION,
          effectiveAgentId: "cellect-fi-guest",
        },
        GUEST,
      ),
    ).toBe(true);
    expect(hookRequesterScopeAllowed({ effectiveAgentId: "cellect-fi-guest" }, GUEST)).toBe(false);
    expect(
      hookRequesterScopeAllowed(
        {
          requesterAttestation: GUEST_ATTESTATION,
          effectiveAgentId: "cellect-fi-guest",
        },
        SHADOW,
      ),
    ).toBe(false);
  });
});
