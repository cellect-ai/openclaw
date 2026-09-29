// Runs a one-off isolated agent turn whose reply cron announces into a channel conversation.
import { randomUUID } from "node:crypto";
import { createDefaultDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronJob } from "../cron/types.js";

export type ChannelAnnouncedAgentTurnParams = {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  deliverTo: string;
  threadId?: string | number;
  route: { agentId: string; sessionKey: string };
  /** Job name shown in cron/task views. */
  name: string;
  message: string;
  timeoutSeconds: number;
  /** Restricts tools; omit to run with the agent's normal tool policy. */
  toolsAllow?: string[];
  /** Marks the message as untrusted external content. */
  externalContentSource?: "webhook";
};

export type ChannelAnnouncedAgentTurnResult =
  | { delivered: true }
  | { delivered: false; reason?: string };

/**
 * Starts an isolated agent turn for a channel-originated trigger (a room join,
 * a reaction) and delivers its reply to the given conversation and thread.
 */
export async function runChannelAnnouncedAgentTurn(
  params: ChannelAnnouncedAgentTurnParams,
): Promise<ChannelAnnouncedAgentTurnResult> {
  const nowMs = Date.now();
  const job: CronJob = {
    id: randomUUID(),
    agentId: params.route.agentId,
    name: params.name,
    enabled: true,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    schedule: { kind: "at", at: new Date(nowMs).toISOString() },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: params.message,
      timeoutSeconds: params.timeoutSeconds,
      ...(params.externalContentSource
        ? { externalContentSource: params.externalContentSource }
        : {}),
      ...(params.toolsAllow ? { toolsAllow: params.toolsAllow } : {}),
    },
    delivery: {
      mode: "announce",
      channel: params.channel,
      to: params.deliverTo,
      ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
      ...(params.accountId !== undefined ? { accountId: params.accountId } : {}),
    },
    state: { nextRunAtMs: nowMs },
  };
  const { runCronIsolatedAgentTurn } = await import("../cron/isolated-agent.js");
  const result = await runCronIsolatedAgentTurn({
    cfg: params.cfg,
    deps: createDefaultDeps(),
    job,
    message: params.message,
    sessionKey: params.route.sessionKey,
    agentId: params.route.agentId,
  });
  if (result.status !== "ok" || result.delivered !== true) {
    return {
      delivered: false,
      reason: result.deliveryError ?? result.error,
    };
  }
  return { delivered: true };
}
