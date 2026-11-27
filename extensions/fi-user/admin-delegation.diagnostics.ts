import { createHash } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { isDiagnosticFlagEnabled } from "openclaw/plugin-sdk/diagnostic-flags";
import { type DelegationDiagnosticReason } from "./admin-delegation.shared.js";

export function createAdminDelegationDiagnostic(api: OpenClawPluginApi) {
  // Existing diagnostic flags/logging own activation and retention. Only an
  // opaque host run id, a closed reason, and booleans cross this boundary.
  const diagnose = (
    context: { runId?: string; sessionKey?: string },
    reason: DelegationDiagnosticReason,
    facts: () => Record<string, boolean> = () => ({}),
  ): void => {
    const { runId, sessionKey } = context;
    if (!runId || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(runId)) {
      return;
    }
    try {
      const cfg = api.runtime.config?.current?.() ?? api.config;
      const runFlag = `fi-user.admin-delegation.${runId.toLowerCase()}`;
      const sessionFlag = sessionKey
        ? `fi-user.admin-delegation.session.${createHash("sha256").update(sessionKey.toLowerCase()).digest("hex")}`
        : undefined;
      // Broad existing diagnostics must not opt a new run into collection.
      const flag = cfg.diagnostics?.flags?.find(
        (value) => value === runFlag || value === sessionFlag,
      );
      if (
        !flag ||
        !isDiagnosticFlagEnabled(flag, {
          diagnostics: { flags: [...(cfg.diagnostics?.flags ?? [])] },
        })
      ) {
        return;
      }
      // The existing SDK run owner bounds delivery and clears its bits on
      // settlement. No diagnostic map, timer, writer, or token state is added.
      const namespace = "admin-delegation-diagnostics";
      const previous = api.runContext.getRunContext({ runId, namespace });
      const delivered = typeof previous === "number" ? previous : 0;
      const bit = reason.startsWith("turn-") ? 1 : reason.startsWith("mint-") ? 2 : 4;
      if (
        (delivered & bit) !== 0 ||
        !api.runContext.setRunContext({ runId, namespace, value: delivered | bit })
      ) {
        return;
      }
      api.logger.info(
        JSON.stringify({ event: "fi-user.admin-delegation", runId, reason, ...facts() }),
      );
    } catch {
      // A diagnostic failure cannot change whether a requester token is issued.
    }
  };
  return { diagnose };
}
