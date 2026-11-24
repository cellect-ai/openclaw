import { createHash } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { brokerToken, resolveFiUserPluginConfig, type PluginConfig } from "./fi-delegation.js";

/** No requester is selected here: Fi verifies the opaque grant and accepted report digest. */
export async function resolvePersonalReviewDelivery(
  cfg: OpenClawConfig,
  input: {
    reviewAttestation: string;
    childSessionKey: string;
    resultText: string;
  },
  signal?: AbortSignal,
): Promise<{ ownerEmail: string; roomId: string; jobId: string }> {
  const raw = cfg.plugins?.entries?.["fi-user"]?.config as PluginConfig | undefined;
  // Delivery requires explicit private routing; resolver defaults do not enroll it.
  // Reject raw operator configuration before normalization can discard unknown values.
  if (!raw?.baseUrl?.trim() || !raw.brokerTokenEnv?.trim() || raw.operatorAgentId !== undefined) {
    throw new Error("review_delivery_unavailable");
  }
  const config = resolveFiUserPluginConfig(raw);
  if (!config.tenantOrgId || config.tenantOrgConflict) {
    throw new Error("review_delivery_unavailable");
  }
  const token = brokerToken({ brokerTokenEnv: config.brokerTokenEnv });
  if (!token) {
    throw new Error("review_delivery_unavailable");
  }
  const response = await fetch(
    `${config.baseUrl.replace(/\/+$/, "")}/api/personal-agent/background-delivery`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        reviewAttestation: input.reviewAttestation,
        sessionKey: input.childSessionKey,
        resultDigest: createHash("sha256").update(input.resultText).digest("hex"),
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
      cache: "no-store",
    },
  );
  const data = (await response.json()) as Record<string, unknown>;
  if (
    !response.ok ||
    data.ok !== true ||
    typeof data.ownerEmail !== "string" ||
    !/^[^\s@]+@[^\s@]+$/.test(data.ownerEmail) ||
    typeof data.roomId !== "string" ||
    !/^![^\s:]+:[^\s]+$/.test(data.roomId) ||
    typeof data.jobId !== "string"
  ) {
    throw new Error("review_delivery_forbidden");
  }
  return { ownerEmail: data.ownerEmail, roomId: data.roomId, jobId: data.jobId };
}
