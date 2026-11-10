import { describe, expect, it } from "vitest";
import {
  lookupHookRequesterAttestation,
  registerHookRequesterAttestation,
} from "./hook-requester-attestation.js";

const ATTESTATION = `fsa:job-1:${"A".repeat(43)}`;
const SHADOW = "agent:cellect-fi-user:hook:fi-shadow:abc";

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
