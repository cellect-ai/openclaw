import { expect, it } from "vitest";
import {
  normalizeMailWakeSourceLock,
  registerMailWakeSourceLock,
  lookupMailWakeSourceLock,
  lookupMailWakeSessionKey,
} from "./mail-wake-source-lock.js";
const receipt = `slw:fixture:${"a".repeat(43)}`;
it("admits the host field only on the authenticated generic mail hook namespace", () => {
  expect(
    normalizeMailWakeSourceLock({ sourceLockCapability: receipt }, "hook:fi-mail:thread"),
  ).toEqual({ ok: true, value: { sourceLockCapability: receipt } });
  for (const session of [undefined, "hook:fi-co:x", "hook:fi-rfi:x", "hook:other:fi-mail:x"])
    expect(normalizeMailWakeSourceLock({ sourceLockCapability: receipt }, session).ok).toBe(false);
  expect(
    normalizeMailWakeSourceLock(
      { message: `sourceLockCapability ${receipt}` },
      "hook:fi-mail:thread",
    ),
  ).toEqual({ ok: true, value: {} });
});
it("keeps concurrent persistent-thread receipts bound to their exact run and clears only that owner", () => {
  const sessionKey = "agent:cellect-fi-admin:hook:fi-mail:thread";
  const other = `slw:other:${"b".repeat(43)}`;
  const releaseA = registerMailWakeSourceLock({ runId: "run-a", sessionKey, capability: receipt });
  const releaseB = registerMailWakeSourceLock({ runId: "run-b", sessionKey, capability: other });
  expect(lookupMailWakeSourceLock("run-a", sessionKey)).toBe(receipt);
  expect(lookupMailWakeSourceLock("run-b", sessionKey)).toBe(other);
  expect(lookupMailWakeSourceLock("run-a", `${sessionKey}-other`)).toBeUndefined();
  releaseA();
  expect(lookupMailWakeSourceLock("run-a", sessionKey)).toBeUndefined();
  expect(lookupMailWakeSourceLock("run-b", sessionKey)).toBe(other);
  releaseB();
});
it("keeps isolated mail origin identified when its source receipt is absent", () => {
  const actual = "agent:cellect-fi-admin:cron:isolated:run:session";
  const release = registerMailWakeSourceLock({
    runId: "missing-source",
    sessionKey: actual,
    mailSessionKey: "agent:cellect-fi-admin:hook:fi-mail:thread",
    capability: undefined,
  });
  expect(lookupMailWakeSourceLock("missing-source", actual)).toBeUndefined();
  release();
});
it("refuses excess admission without erasing an active isolated source owner", () => {
  const releases: Array<() => void> = [];
  const actual = "agent:cellect-fi-admin:cron:isolated:run:session";
  const logical = "agent:cellect-fi-admin:hook:fi-mail:thread";
  try {
    for (let index = 0; index < 512; index++)
      releases.push(
        registerMailWakeSourceLock({
          runId: `capacity-${index}`,
          sessionKey: actual,
          mailSessionKey: logical,
          capability: receipt,
        }),
      );
    expect(() =>
      registerMailWakeSourceLock({
        runId: "overflow",
        sessionKey: actual,
        mailSessionKey: logical,
        capability: receipt,
      }),
    ).toThrow("Mail source custody capacity reached");
    expect(lookupMailWakeSourceLock("capacity-0", actual)).toBe(receipt);
    expect(lookupMailWakeSessionKey("capacity-0", actual)).toBe(logical);
    expect(lookupMailWakeSessionKey("overflow", actual)).toBeUndefined();
  } finally {
    for (const release of releases) release();
  }
});
