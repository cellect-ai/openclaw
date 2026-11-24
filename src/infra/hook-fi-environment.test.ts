import { describe, expect, it } from "vitest";
import {
  hasHookFiRoute,
  lookupHookFiEnvironment,
  normalizeHookFiEnvironment,
  registerHookFiEnvironment,
} from "./hook-fi-environment.js";

describe("hook Fi environment", () => {
  it("accepts a named environment, agreeing with requesterEnvironment when both are present", () => {
    expect(normalizeHookFiEnvironment({})).toEqual({ ok: true, value: {} });
    expect(normalizeHookFiEnvironment({ fiEnvironment: "dev" })).toEqual({
      ok: true,
      value: { fiEnvironment: "dev" },
    });
    expect(
      normalizeHookFiEnvironment({ fiEnvironment: "dev", requesterEnvironment: "dev" }).ok,
    ).toBe(true);
    expect(
      normalizeHookFiEnvironment({ fiEnvironment: "dev", requesterEnvironment: "prod" }).ok,
    ).toBe(false);
    for (const fiEnvironment of ["", "Dev", "qa", 1, null]) {
      expect(normalizeHookFiEnvironment({ fiEnvironment }).ok).toBe(false);
    }
  });

  it("finds a route only in the explicit matrixEnvironments entry", () => {
    const cfg = (routes: unknown) => ({
      plugins: { entries: { "fi-user": { config: { matrixEnvironments: routes } } } },
    });
    const dev = { baseUrl: "https://dev.fi.example", brokerTokenEnv: "BROKER_DEV" };
    expect(hasHookFiRoute(cfg({ dev }), "dev")).toBe(true);
    expect(hasHookFiRoute(cfg({ dev }), "prod")).toBe(false);
    expect(hasHookFiRoute(cfg({ dev: { baseUrl: "https://dev.fi.example" } }), "dev")).toBe(false);
    expect(hasHookFiRoute(cfg(Object.create({ dev })), "dev")).toBe(false);
    expect(hasHookFiRoute({}, "prod")).toBe(false);
  });

  it("binds the environment to its exact run and session until released", () => {
    const release = registerHookFiEnvironment({
      runId: "run-1",
      sessionKey: "agent:cellect-fi-admin:hook:x",
      environment: "dev",
    });
    expect(lookupHookFiEnvironment("run-1", "agent:cellect-fi-admin:hook:X")).toBe("dev");
    expect(lookupHookFiEnvironment("run-1", "agent:cellect-fi-admin:hook:y")).toBeUndefined();
    expect(lookupHookFiEnvironment("run-2", "agent:cellect-fi-admin:hook:x")).toBeUndefined();
    release();
    expect(lookupHookFiEnvironment("run-1", "agent:cellect-fi-admin:hook:x")).toBeUndefined();
    registerHookFiEnvironment({ runId: "run-3", sessionKey: "s", environment: undefined });
    expect(lookupHookFiEnvironment("run-3", "s")).toBeUndefined();
  });
});
