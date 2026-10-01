import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";

type MatrixThreadReplies = "off" | "inbound" | "always";

type MatrixThreadRouting = {
  threadId?: string;
};

export function resolveMatrixThreadSessionKeys(params: {
  baseSessionKey: string;
  threadId?: string | null;
  parentSessionKey?: string;
  useSuffix?: boolean;
}): { sessionKey: string; parentSessionKey?: string } {
  return resolveThreadSessionKeys({
    ...params,
    // Matrix event IDs are opaque and case-sensitive; keep the exact thread root.
    normalizeThreadId: (threadId) => threadId,
  });
}

export function resolveMatrixThreadRouting(params: {
  isDirectMessage: boolean;
  threadReplies: MatrixThreadReplies;
  dmThreadReplies?: MatrixThreadReplies;
  messageId: string;
  threadRootId?: string;
}): MatrixThreadRouting {
  const effectiveThreadReplies =
    params.isDirectMessage && params.dmThreadReplies !== undefined
      ? params.dmThreadReplies
      : params.threadReplies;
  const messageId = params.messageId.trim();
  const threadRootId = params.threadRootId?.trim();
  const inboundThreadId = threadRootId && threadRootId !== messageId ? threadRootId : undefined;
  const threadId =
    effectiveThreadReplies === "off"
      ? undefined
      : effectiveThreadReplies === "inbound"
        ? inboundThreadId
        : (inboundThreadId ?? (messageId || undefined));

  return {
    threadId,
  };
}

export type MatrixInboundRouteKind = "thread" | "new_root" | "flat";

export type MatrixInboundRouteLog = {
  outcome: "dispatch" | "skip";
  reason?: string;
  roomId: string;
  eventId: string;
  accountId: string;
  isDirectMessage: boolean;
  threadReplies: MatrixThreadReplies;
  dmThreadReplies?: MatrixThreadReplies;
  threadRootId?: string;
  sessionThreadId?: string;
  mentioned?: boolean;
};

/**
 * One stdout record per admitted-or-skipped Matrix inbound, joinable to Fi
 * mint/authorize by roomId + eventId. Never includes message bodies.
 */
export function logMatrixInboundRoute(params: MatrixInboundRouteLog): {
  kind: MatrixInboundRouteKind;
  mismatch: boolean;
} {
  const messageId = params.eventId.trim();
  const threadRootId = params.threadRootId?.trim() || undefined;
  const inboundThreadId = threadRootId && threadRootId !== messageId ? threadRootId : undefined;
  const sessionThreadId = params.sessionThreadId?.trim() || undefined;
  const kind: MatrixInboundRouteKind = inboundThreadId
    ? "thread"
    : sessionThreadId === messageId
      ? "new_root"
      : "flat";
  const mismatch = Boolean(
    inboundThreadId && sessionThreadId && inboundThreadId !== sessionThreadId,
  );
  const record = {
    evt: "matrix.inbound_route",
    outcome: params.outcome,
    ...(params.reason ? { reason: params.reason } : {}),
    roomId: params.roomId,
    eventId: params.eventId,
    accountId: params.accountId,
    isDirectMessage: params.isDirectMessage,
    threadRootId: threadRootId ?? null,
    sessionThreadId: sessionThreadId ?? null,
    kind,
    mentioned: params.mentioned ?? null,
  };
  console.info(JSON.stringify(record));
  if (mismatch) {
    console.warn(
      JSON.stringify({
        ...record,
        evt: "matrix.inbound_route_mismatch",
        level: "warn",
      }),
    );
  }
  return { kind, mismatch };
}
