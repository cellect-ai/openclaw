import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveSlackAccount } from "./accounts.js";
import { getSlackWriteClient } from "./client.js";
import { assertSlackDetachedTargetAllowed } from "./detached-target-admission.js";
import { formatSlackError } from "./errors.js";
import { setSlackSessionStatus } from "./session-status.js";
import { canonicalizeSlackApiTargetId, parseSlackTarget } from "./target-parsing.js";
import { resolveSlackThreadTsValue } from "./thread-ts.js";

export async function setSlackHeartbeatThreadStatus(params: {
  cfg: OpenClawConfig;
  to: string;
  accountId?: string | null;
  threadId?: string | number | null;
  status: "processing" | "active";
}) {
  const threadTs = resolveSlackThreadTsValue({ threadId: params.threadId });
  const target = parseSlackTarget(params.to, { defaultKind: "channel" });
  if (!threadTs || !target) {
    return;
  }
  const account = resolveSlackAccount({ cfg: params.cfg, accountId: params.accountId });
  assertSlackDetachedTargetAllowed(account.accountId, target.teamId);
  const botToken = normalizeOptionalString(account.botToken);
  if (!botToken) {
    return;
  }
  try {
    const client = getSlackWriteClient(botToken, { teamId: target.teamId });
    const apiTargetId = canonicalizeSlackApiTargetId(target.kind, target.id, params.to);
    const channelId =
      target.kind === "channel"
        ? apiTargetId
        : await (
            await loadSlackSendRuntime()
          ).resolveSlackDmChannelId({
            client,
            userId: apiTargetId,
            accountId: account.accountId,
            token: botToken,
          });
    await setSlackSessionStatus({
      client,
      token: botToken,
      channelId,
      threadTs,
      status: params.status,
    });
  } catch (error) {
    logVerbose(`slack heartbeat status update failed: ${formatSlackError(error)}`);
  }
}

const loadSlackSendRuntime = createLazyRuntimeModule(() => import("./send.js"));
