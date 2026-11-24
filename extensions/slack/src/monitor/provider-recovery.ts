import { formatSlackError } from "../errors.js";
import type { SlackMonitorContext } from "./context.js";
import type { createSlackMessageHandler } from "./message-handler.js";
import { recoverSlackMissedMentions } from "./missed-mentions.js";
/** One monitor-owned sweep queue preserves identity fencing across reconnects. */
export function createSlackReconnectRecovery(params: {
  ctx: SlackMonitorContext;
  accountId: string;
  client: SlackMonitorContext["app"]["client"];
  runtime: SlackMonitorContext["runtime"];
  recoverySignal: AbortSignal;
  handleSlackMessage: ReturnType<typeof createSlackMessageHandler>;
}) {
  const { ctx, accountId, client, runtime, recoverySignal, handleSlackMessage } = params;
  const recoveryKey = () => {
    const identity = ctx.installationIdentity;
    if (
      identity.kind === "degraded" ||
      ctx.identityHealth.lifecycle === "blocked" ||
      !ctx.botUserId
    ) {
      return undefined;
    }
    const installationId = identity.kind === "workspace" ? identity.teamId : identity.enterpriseId;
    if (!installationId.trim()) {
      return undefined;
    }
    return JSON.stringify([
      accountId,
      identity.kind,
      installationId,
      identity.apiAppId ?? "",
      ctx.botUserId,
      ctx.botId ?? "",
    ]);
  };
  let pendingRecovery: { key: string; lastAliveAt: number } | undefined;
  let recoveryRunning = false;
  recoverySignal.addEventListener(
    "abort",
    () => {
      pendingRecovery = undefined;
    },
    { once: true },
  );
  const drainRecovery = async () => {
    try {
      while (pendingRecovery && !recoverySignal.aborted) {
        const window = pendingRecovery;
        pendingRecovery = undefined;
        if (window.key !== recoveryKey()) {
          continue;
        }
        try {
          await recoverSlackMissedMentions({
            ctx: { ...ctx },
            client: client,
            lastAliveAt: window.lastAliveAt,
            dispatch: async (message) => {
              if (recoverySignal.aborted || window.key !== recoveryKey()) {
                throw new Error("Slack recovery monitor or identity retired");
              }
              await handleSlackMessage(message, { source: "message" });
            },
            abortSignal: recoverySignal,
          });
        } catch (error: unknown) {
          runtime.error?.(`slack missed-mention recovery failed: ${formatSlackError(error)}`);
        }
      }
    } finally {
      recoveryRunning = false;
    }
  };
  const requestRecovery = (lastAliveAt: number | undefined) => {
    if (lastAliveAt === undefined || !Number.isFinite(lastAliveAt) || recoverySignal.aborted) {
      return;
    }
    const key = recoveryKey();
    if (key === undefined) {
      return;
    }
    pendingRecovery = {
      key,
      lastAliveAt:
        pendingRecovery?.key === key
          ? Math.min(pendingRecovery.lastAliveAt, lastAliveAt)
          : lastAliveAt,
    };
    if (!recoveryRunning) {
      recoveryRunning = true;
      void drainRecovery();
    }
  };

  return requestRecovery;
}
