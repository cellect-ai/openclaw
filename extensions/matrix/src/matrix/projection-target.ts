import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveSessionAgentIdStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-binding-runtime";
import { getSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CoreConfig } from "../types.js";
import { resolveDefaultMatrixAccountId } from "./accounts.js";
import { ProjectionError } from "./projection-error.js";
import { getMatrixThreadBindingManager, toSessionBindingRecord } from "./thread-bindings-shared.js";
export const MATRIX_SESSION_PROJECTION_BOUND_BY = "session-projection";
function clean(value: unknown): string {
  return normalizeOptionalString(value) ?? "";
}
export function isProjectionBinding(binding: {
  metadata?: Record<string, unknown>;
  conversation: { channel: string };
}): boolean {
  return (
    binding.conversation.channel === "matrix" &&
    [
      MATRIX_SESSION_PROJECTION_BOUND_BY,
      "session-projection-read-only",
      "session-projection-slack-direct",
    ].includes(clean(binding.metadata?.boundBy))
  );
}

export type ProjectionTarget = {
  cfg: CoreConfig;
  targetSessionKey: string;
  roomId: string;
  accountId?: string;
};

export function resolveProjectionTarget(params: ProjectionTarget) {
  const targetSessionKey = clean(params.targetSessionKey);
  const roomId = clean(params.roomId);
  if (!targetSessionKey || !roomId) {
    throw new ProjectionError("invalid_request", "targetSessionKey and roomId are required");
  }
  if (!roomId.startsWith("!")) {
    throw new ProjectionError("invalid_request", "roomId must be a Matrix room id");
  }
  if (targetSessionKey.length > 512 || roomId.length > 255) {
    throw new ProjectionError("invalid_request", "targetSessionKey or roomId is too long");
  }
  const accountId = normalizeAccountId(
    clean(params.accountId) || resolveDefaultMatrixAccountId(params.cfg),
  );
  if (!getMatrixThreadBindingManager(accountId)) {
    throw new ProjectionError("account_unavailable", `Matrix account ${accountId} is not running`);
  }
  const agentId = resolveSessionAgentIdStrict({ config: params.cfg, sessionKey: targetSessionKey });
  if (!getSessionEntry({ sessionKey: targetSessionKey, agentId })) {
    throw new ProjectionError("session_missing", "target OpenClaw session does not exist");
  }
  return { targetSessionKey, accountId, agentId, roomId };
}

export function findProjectionBinding(
  target: ReturnType<typeof resolveProjectionTarget>,
  readOnly = false,
) {
  if (readOnly) {
    const shared = getMatrixThreadBindingManager(target.accountId)
      ?.listBindings?.()
      .toSorted((left, right) => right.boundAt - left.boundAt)
      .find(
        (binding) =>
          binding.parentConversationId === target.roomId &&
          binding.boundBy === "session-projection-read-only",
      );
    if (shared) {
      return toSessionBindingRecord(shared, { idleTimeoutMs: 0, maxAgeMs: 0 });
    }
  }
  return getSessionBindingService()
    .listBySession(target.targetSessionKey)
    .find(
      (binding) =>
        isProjectionBinding(binding) &&
        binding.conversation.accountId === target.accountId &&
        binding.conversation.parentConversationId === target.roomId,
    );
}
