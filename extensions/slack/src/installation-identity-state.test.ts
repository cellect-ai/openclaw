import { describe, expect, it } from "vitest";
import {
  registerSlackInstallationState,
  resolveSlackAccountBindingScope,
} from "./installation-identity-state.js";

describe("authenticated Slack account binding scope", () => {
  it("uses monitor-owned workspace identity and drops it when degraded or released", () => {
    const state = registerSlackInstallationState("scope-fixture", "workspace", "T_AUTHENTICATED");
    try {
      expect(resolveSlackAccountBindingScope({ accountId: "scope-fixture" })).toEqual({
        groupSpace: "T_AUTHENTICATED",
      });
      state.update("degraded", "T_STALE");
      expect(resolveSlackAccountBindingScope({ accountId: "scope-fixture" })).toBeUndefined();
      state.update("enterprise", "T_REQUESTED");
      expect(resolveSlackAccountBindingScope({ accountId: "scope-fixture" })).toBeUndefined();
    } finally {
      state.release();
    }
    expect(resolveSlackAccountBindingScope({ accountId: "scope-fixture" })).toBeUndefined();
  });
});
