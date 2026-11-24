import { getLoadedChannelPlugin } from "../../channels/plugins/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadCompletedDeliveryReceipt } from "../../infra/outbound/delivery-queue-storage.js";
import { sendMessage } from "../../infra/outbound/message.js";
import { resolveOutboundSessionRoute } from "../../infra/outbound/outbound-session.js";
import { readFiUserMatrixRoom } from "./fi-shadow-matrix-room.js";
import { roomAudienceAllowsOwner } from "./fi-shadow-room-audience.js";

type ReviewOwner = { ownerEmail: string; roomId: string; jobId: string };

/**
 * The room's canonical conversation thread, so a reply to the briefing lands
 * where the agent answers. Unresolvable means the room-level post as before.
 */
async function resolveCanonicalThreadId(cfg: OpenClawConfig, accountId: string, roomId: string) {
  try {
    const threadId = await getLoadedChannelPlugin("matrix")?.groups?.resolveCanonicalThreadId?.({
      cfg,
      accountId,
      groupId: roomId,
    });
    return typeof threadId === "string" && /^\$\S+$/.test(threadId) ? threadId : undefined;
  } catch {
    return undefined;
  }
}

/** Publish Fi's already frozen report as the bot, without inventing a human Matrix turn. */
export async function publishPersonalReviewReport(params: {
  getConfig: () => OpenClawConfig;
  owner: ReviewOwner;
  resultText: string;
  idempotencyKey: string;
  assertOwnerCurrent: () => Promise<void>;
  signal?: AbortSignal;
}) {
  const assertActive = () => params.signal?.throwIfAborted();
  let accountId: string | undefined;
  let accountUserId: string | undefined;
  const assertCurrent = async () => {
    assertActive();
    await params.assertOwnerCurrent();
    const room = await readFiUserMatrixRoom({
      cfg: params.getConfig(),
      roomId: params.owner.roomId,
      assertCurrent: assertActive,
    });
    assertActive();
    if (
      !room.ok ||
      !roomAudienceAllowsOwner({
        members: room.members,
        ownerEmail: params.owner.ownerEmail,
        accountUserId: room.accountUserId,
      }) ||
      (accountId !== undefined && room.accountId !== accountId) ||
      (accountUserId !== undefined && room.accountUserId !== accountUserId)
    ) {
      throw new Error("review_publication_audience_changed");
    }
    accountId = room.accountId;
    accountUserId = room.accountUserId;
    // Native membership reads yield: revoke an expired/closed Fi grant before any I/O.
    await params.assertOwnerCurrent();
    assertActive();
  };
  await assertCurrent();
  const recorded = await loadCompletedDeliveryReceipt(params.idempotencyKey);
  if (recorded?.platformMessageId) {
    await assertCurrent();
    return { path: "direct" as const, messageId: recorded.platformMessageId };
  }
  const threadId = accountId
    ? await resolveCanonicalThreadId(params.getConfig(), accountId, params.owner.roomId)
    : undefined;
  assertActive();
  const roomSessionKey = `agent:cellect-fi-user:matrix:channel:${params.owner.roomId}`;
  const sessionKey = threadId ? `${roomSessionKey}:thread:${threadId}` : roomSessionKey;
  const transcriptRoute = await resolveOutboundSessionRoute({
    cfg: params.getConfig(),
    channel: "matrix",
    agentId: "cellect-fi-user",
    accountId,
    target: params.owner.roomId,
    threadId,
    currentSessionKey: sessionKey,
    assertDirectAdapterHandoff: assertActive,
  });
  await assertCurrent();
  if (!transcriptRoute) throw new Error("review_publication_route_unavailable");
  const sent = await sendMessage({
    cfg: params.getConfig(),
    channel: "matrix",
    to: params.owner.roomId,
    accountId,
    ...(threadId ? { threadId } : {}),
    agentId: "cellect-fi-user",
    // A frozen report is not a turn produced by the destination conversation.
    // Carry its delivery policy without suppressing native destination history.
    session: {
      policyKey: sessionKey,
      agentId: "cellect-fi-user",
      requesterAccountId: accountId,
      conversationType: "group",
      conversationKind: "channel",
    },
    content: params.resultText,
    payloads: [{ text: params.resultText }],
    gatewayOwnedDelivery: true,
    idempotencyKey: params.idempotencyKey,
    deliveryIntentId: params.idempotencyKey,
    completionRetention: {
      idPrefix: "review:",
      maxAgeMs: 30 * 24 * 60 * 60_000,
      maxEntries: 2_000,
    },
    deliveryRetryOwner: "caller",
    recoveryPolicy: "reconcile_only",
    queuePolicy: "required",
    abortSignal: params.signal,
    onDeliveryAttempt: assertCurrent,
    onPlatformSendDispatch: assertCurrent,
    assertDirectAdapterHandoff: assertActive,
    transcriptRoute,
  });
  if (sent.deliveryStatus !== "sent" || !sent.result?.messageId) {
    throw new Error("review_publication_unconfirmed");
  }
  return { path: "direct" as const, deliveredAt: Date.now(), messageId: sent.result.messageId };
}
