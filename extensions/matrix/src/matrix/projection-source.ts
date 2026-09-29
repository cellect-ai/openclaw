import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { listAllBindings, resolveBindingKey } from "./thread-bindings-shared.js";

export function parseProjectionBindingMetadata(value: Record<string, unknown> | undefined) {
  const sourceSnapshotDigest = normalizeOptionalString(value?.sourceSnapshotDigest);
  const sourceSnapshotReconciledAtMs = value?.sourceSnapshotReconciledAtMs;
  const registryGeneration = value?.registryGeneration;
  return {
    externalSource: parseProjectionExternalSource(value?.externalSource),
    sourceReplyAuthorization: normalizeOptionalString(value?.sourceReplyAuthorization) || undefined,
    sourceAccountId: normalizeOptionalString(value?.sourceAccountId) || undefined,
    sourceActorId: normalizeOptionalString(value?.sourceActorId) || undefined,
    environment: normalizeOptionalString(value?.environment) || undefined,
    projectedConversationId: normalizeOptionalString(value?.projectedConversationId) || undefined,
    sourceSnapshotDigest:
      sourceSnapshotDigest && /^[a-f0-9]{64}$/.test(sourceSnapshotDigest)
        ? sourceSnapshotDigest
        : undefined,
    sourceSnapshotReconciledAtMs:
      typeof sourceSnapshotReconciledAtMs === "number" &&
      Number.isFinite(sourceSnapshotReconciledAtMs) &&
      sourceSnapshotReconciledAtMs >= 0
        ? Math.floor(sourceSnapshotReconciledAtMs)
        : undefined,
    registryGeneration:
      Number.isSafeInteger(registryGeneration) && Number(registryGeneration) > 0
        ? Number(registryGeneration)
        : undefined,
  };
}

/** Native inventory remains available after its source session is pruned. */
export function listReadOnlyMatrixSessionProjections() {
  const rooms = new Set<string>();
  return listAllBindings()
    .toSorted((left, right) => right.boundAt - left.boundAt)
    .flatMap((binding) => {
      const roomId = binding.parentConversationId;
      if (
        !["session-projection-read-only", "session-projection-slack-direct"].includes(
          binding.boundBy ?? "",
        ) ||
        !roomId ||
        rooms.has(roomId)
      ) {
        return [];
      }
      rooms.add(roomId);
      return [
        {
          sessionKey: binding.targetSessionKey,
          roomId,
          externalSource: binding.externalSource,
          sourceAccountId: binding.sourceAccountId,
        },
      ];
    });
}

/** Persisted owner facts; no session mutation or source replay. */
export function getMatrixProjectionStatus(roomId: string, accountId?: string) {
  if (!roomId.startsWith("!") || roomId.length > 255) {
    throw new Error("A Matrix room id is required");
  }
  const bindings = listAllBindings()
    .filter(
      (binding) =>
        binding.parentConversationId === roomId &&
        (!accountId || binding.accountId === accountId) &&
        binding.boundBy?.startsWith("session-projection"),
    )
    .toSorted((left, right) => right.boundAt - left.boundAt);
  if (new Set(bindings.map((binding) => binding.accountId)).size > 1) {
    throw new Error("Projection account is ambiguous; specify accountId");
  }
  const binding = bindings[0];
  if (!binding) {
    return { status: "missing" as const, roomId };
  }
  return {
    status: "existing" as const,
    bindingId: resolveBindingKey(binding),
    roomId,
    accountId: binding.accountId,
    agentId: binding.agentId,
    threadRootEventId: binding.conversationId,
    targetSessionKey: binding.targetSessionKey,
    sourceReplyAuthorization: binding.sourceReplyAuthorization,
    externalSource: binding.externalSource,
    environment: binding.environment,
    conversationId: binding.projectedConversationId,
  };
}

export type ProjectionExternalSource = {
  provider: string;
  workspaceId: string;
  channelId: string;
  rootMessageId: string;
  peerSenderId?: string;
};

export function resolveDetachedProjectionSource(params: {
  sourceDetached?: boolean;
  sourceDirect?: boolean;
  readOnly?: boolean;
  sourceReplyAuthorization?: string;
  externalSource?: unknown;
  targetSessionKey: string;
}) {
  const source = parseProjectionExternalSource(params.externalSource);
  if (params.sourceDetached) {
    const parent = /^agent:[^:]+:slack:(?:channel|group):([cg][a-z0-9]+)$/i.exec(
      params.targetSessionKey,
    );
    if (
      (!params.readOnly && !params.sourceReplyAuthorization) ||
      params.sourceDirect ||
      !source ||
      source.provider !== "slack" ||
      parent?.[1]?.toUpperCase() !== source.channelId ||
      !/^T[A-Z0-9]+$/.test(source.workspaceId) ||
      !/^\d+\.\d+$/.test(source.rootMessageId)
    ) {
      throw new Error("Detached source requires a matching read-only parent session");
    }
  }
  return source;
}

export function parseProjectionExternalSource(
  value: unknown,
): ProjectionExternalSource | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const field = (key: string) =>
    typeof source[key] === "string" && source[key].length <= 255 ? source[key] : undefined;
  const provider = field("provider");
  const workspaceId = field("workspaceId");
  const channelId = field("channelId");
  const rootMessageId = field("rootMessageId");
  if (!provider || !workspaceId || !channelId || !rootMessageId) {
    return undefined;
  }
  return {
    provider,
    workspaceId,
    channelId,
    rootMessageId,
    ...(field("peerSenderId") ? { peerSenderId: field("peerSenderId") } : {}),
  };
}
