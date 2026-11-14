import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sendMessage } from "../../infra/outbound/message.js";
import { readFiUserMatrixRoom } from "./fi-shadow-matrix-room.js";
import { roomAudienceAllowsOwner } from "./fi-shadow-room-audience.js";

type ReviewOwner = { ownerEmail: string; roomId: string; jobId: string };

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
  const sessionKey = `agent:cellect-fi-user:matrix:channel:${params.owner.roomId}`;
  const sent = await sendMessage({
    cfg: params.getConfig(),
    channel: "matrix",
    to: params.owner.roomId,
    accountId,
    agentId: "cellect-fi-user",
    requesterSessionKey: sessionKey,
    conversationType: "channel",
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
    mirror: { sessionKey, agentId: "cellect-fi-user", idempotencyKey: params.idempotencyKey },
  });
  if (sent.deliveryStatus !== "sent" || !sent.result?.messageId) {
    throw new Error("review_publication_unconfirmed");
  }
  return { path: "direct" as const, deliveredAt: Date.now(), messageId: sent.result.messageId };
}
