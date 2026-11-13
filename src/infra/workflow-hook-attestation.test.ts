import { describe, it, expect } from "vitest";
import { shadowHookRunParams } from "../agents/shadow-hook-tool-policy.js";
import {
  normalizeHookRequesterAttestation,
  registerHookRequesterAttestation,
  lookupHookRequesterAttestation,
  lookupHookRequesterEnvironment,
} from "./hook-requester-attestation.js";
describe("separate construction hook custody", () => {
  it.each([
    ["rfi", "fsa", "rfi_prepare_draft"],
    ["co", "fcw", "co_prepare_draft"],
  ])("admits only the %s tool under native session custody", (workflow, codec, tool) => {
    const sessionKey = `hook:fi-${workflow}:operation`,
      attestation = `${codec}:job:${"a".repeat(43)}`;
    expect(
      normalizeHookRequesterAttestation(
        { requesterAttestation: attestation, requesterEnvironment: "dev", deliver: false },
        sessionKey,
      ),
    ).toEqual({
      ok: true,
      value: { requesterAttestation: attestation, requesterEnvironment: "dev" },
    });
    const release = registerHookRequesterAttestation({
      runId: workflow,
      sessionKey,
      attestation,
      environment: "dev",
    });
    expect(lookupHookRequesterAttestation(workflow, sessionKey)).toBe(attestation);
    expect(lookupHookRequesterAttestation(workflow, `${sessionKey}other`)).toBeUndefined();
    expect(lookupHookRequesterEnvironment(workflow, sessionKey)).toBe("dev");
    const policy = shadowHookRunParams(sessionKey, {
      toolsAllow: ["*"],
      toolExecutionAllow: ["*"],
    });
    expect(policy).toMatchObject({
      toolsAllow: [tool],
      toolExecutionAllow: [tool],
      disableMessageTool: true,
      disableToolSearch: true,
    });
    release();
    expect(lookupHookRequesterAttestation(workflow, sessionKey)).toBeUndefined();
  });
  it("rejects cross-codec and delivery widening", () => {
    const token = `fsa:job:${"a".repeat(43)}`;
    expect(
      normalizeHookRequesterAttestation({ requesterAttestation: token }, "hook:fi-co:op").ok,
    ).toBe(false);
    expect(
      normalizeHookRequesterAttestation(
        { requesterAttestation: `fcw:job:${"a".repeat(43)}` },
        "hook:fi-rfi:op",
      ).ok,
    ).toBe(false);
    expect(
      normalizeHookRequesterAttestation(
        { requesterAttestation: token, deliver: true },
        "hook:fi-rfi:op",
      ).ok,
    ).toBe(false);
    expect(normalizeHookRequesterAttestation({}, "hook:fi-co:op").ok).toBe(false);
    expect(
      normalizeHookRequesterAttestation({ requesterAttestation: token }, "hook:fi-mail:op").ok,
    ).toBe(false);
  });
});
