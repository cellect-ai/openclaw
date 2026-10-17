import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listMatrixAccountIds, resolveMatrixAccount } from "./account-resolver-api.js";
import { getMatrixScopedEnvVarNames } from "./src/env-vars.js";
import { clearMatrixCredentials, saveMatrixCredentials } from "./src/matrix/credentials.js";
import { installMatrixTestRuntime } from "./src/test-runtime.js";

describe("Matrix account identity projection", () => {
  let stateDir = "";
  const homeserver = "https://matrix.example.org";
  const cfg = { channels: { matrix: { homeserver, accounts: { ops: {}, alerts: {} } } } };

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-identity-"));
    installMatrixTestRuntime({ stateDir });
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    for (const accountId of ["ops", "alerts"]) {
      vi.stubEnv(getMatrixScopedEnvVarNames(accountId).accessToken, `${accountId}-token`);
      await saveMatrixCredentials(
        { homeserver, userId: `@${accountId}:example.org`, accessToken: `${accountId}-token` },
        process.env,
        accountId,
      );
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetPluginStateStoreForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("uniquely identifies token-only accounts using persisted authenticated identities", () => {
    const matches = listMatrixAccountIds(cfg).filter(
      (accountId) => resolveMatrixAccount({ cfg, accountId }).userId === "@ops:example.org",
    );
    expect(matches).toEqual(["ops"]);
    expect(resolveMatrixAccount({ cfg, accountId: "alerts" }).userId).toBe("@alerts:example.org");
  });

  it.each(["token", "homeserver"])("does not trust stored identity after %s changes", (field) => {
    if (field === "token") {
      vi.stubEnv(getMatrixScopedEnvVarNames("ops").accessToken, "replacement-token");
    }
    const changedCfg =
      field === "homeserver"
        ? {
            channels: {
              matrix: { ...cfg.channels.matrix, homeserver: "https://other.example.org" },
            },
          }
        : cfg;
    expect(resolveMatrixAccount({ cfg: changedCfg, accountId: "ops" }).userId).toBeUndefined();
    expect(resolveMatrixAccount({ cfg, accountId: "alerts" }).userId).toBe("@alerts:example.org");
  });

  it("does not resurrect a revoked account identity", () => {
    clearMatrixCredentials(process.env, "ops");
    expect(resolveMatrixAccount({ cfg, accountId: "ops" }).userId).toBeUndefined();
    expect(resolveMatrixAccount({ cfg, accountId: "alerts" }).userId).toBe("@alerts:example.org");
  });

  it("preserves explicit user ID precedence over persisted identity", () => {
    vi.stubEnv(getMatrixScopedEnvVarNames("ops").userId, "@configured:example.org");
    expect(resolveMatrixAccount({ cfg, accountId: "ops" }).userId).toBe("@configured:example.org");
  });
});
