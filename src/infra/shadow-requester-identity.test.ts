import { expect, it } from "vitest";
import {
  lookupShadowRequesterIdentity,
  registerShadowRequesterIdentity,
} from "./shadow-requester-identity.js";

const SESSION = "agent:cellect-fi-user:hook:fi-shadow:identity-1";
const BARE = "hook:fi-shadow:identity-1";

it("records a plain email for the shadow tail and ignores anything else", () => {
  registerShadowRequesterIdentity(SESSION, "Alex@Example.com");
  expect(lookupShadowRequesterIdentity(BARE)).toBe("alex@example.com");
  expect(lookupShadowRequesterIdentity("hook:fi-shadow:other")).toBeUndefined();

  registerShadowRequesterIdentity("agent:cellect-fi-user:hook:fi-mail:abc", "alex@example.com");
  expect(lookupShadowRequesterIdentity("hook:fi-mail:abc")).toBeUndefined();
  registerShadowRequesterIdentity(SESSION, "not an email");
  expect(lookupShadowRequesterIdentity(SESSION)).toBe("alex@example.com");
});
