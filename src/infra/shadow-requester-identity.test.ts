import { beforeAll, afterAll, expect, it, vi } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
let state: OpenClawTestState;
beforeAll(async () => {
  state = await createOpenClawTestState({ label: "shadow-requester" });
});
afterAll(async () => {
  await state.cleanup();
});
import {
  lookupShadowRequesterIdentity,
  registerShadowRequesterIdentity,
} from "./shadow-requester-identity.js";

const SESSION = "agent:cellect-fi-user:hook:fi-shadow:identity-1";
const BARE = "hook:fi-shadow:identity-1";

it("records a plain email for the shadow tail and ignores anything else", async () => {
  await registerShadowRequesterIdentity(SESSION, "Alex@Example.com");
  expect(await lookupShadowRequesterIdentity(BARE)).toBe("alex@example.com");
  expect(await lookupShadowRequesterIdentity("hook:fi-shadow:other")).toBeUndefined();

  await registerShadowRequesterIdentity(
    "agent:cellect-fi-user:hook:fi-mail:abc",
    "alex@example.com",
  );
  expect(await lookupShadowRequesterIdentity("hook:fi-mail:abc")).toBeUndefined();
  await registerShadowRequesterIdentity(SESSION, "not an email");
  expect(await lookupShadowRequesterIdentity(SESSION)).toBe("alex@example.com");
});

it("shares resolved identity across independently loaded modules", async () => {
  await registerShadowRequesterIdentity("hook:fi-shadow:independent", "owner@example.com");
  vi.resetModules();
  const other = await import("./shadow-requester-identity.js");
  expect(await other.lookupShadowRequesterIdentity("hook:fi-shadow:independent")).toBe(
    "owner@example.com",
  );
});
