import { getOptionalMatrixRuntime } from "../runtime.js";
import { getSourceAuthorizedProjection } from "./projection-reply-authorization.js";

type BoundSourceReplyDelivery = {
  deliver: (params: {
    channelId: string;
    threadTs: string;
    text: string;
    idempotencyKey: string;
  }) => Promise<void>;
};

/**
 * A reply admitted from the projected room continues the Slack session.
 * Post that answer in the Slack thread as well. The Slack copy is marked so
 * the room mirror does not add it a second time.
 */
export async function deliverBoundSourceReply(params: {
  matrixAccountId: string;
  roomId: string;
  sessionKey: string;
  triggerEventId: string;
  partIndex: number;
  text: string;
}): Promise<void> {
  const text = params.text.trim();
  if (!text || !Number.isInteger(params.partIndex) || params.partIndex < 0) {
    return;
  }
  const binding = getSourceAuthorizedProjection(params.matrixAccountId, params.roomId);
  const source = binding?.externalSource;
  if (
    !binding?.sourceAccountId ||
    binding.targetSessionKey.toLowerCase() !== params.sessionKey.toLowerCase() ||
    source?.provider !== "slack" ||
    !/^[CDG][A-Z0-9]+$/.test(source.channelId) ||
    !/^\d+\.\d+$/.test(source.rootMessageId)
  ) {
    return;
  }
  const runtime = getOptionalMatrixRuntime();
  const delivery = runtime?.channel.runtimeContexts?.get<BoundSourceReplyDelivery>({
    channelId: "slack",
    accountId: binding.sourceAccountId,
    capability: "bound-source-reply",
  });
  if (!delivery) {
    throw new Error("Bound source reply delivery is unavailable");
  }
  await delivery.deliver({
    channelId: source.channelId,
    threadTs: source.rootMessageId,
    text,
    idempotencyKey: [
      "bound-source-reply",
      params.roomId,
      params.triggerEventId,
      String(params.partIndex),
    ].join(":"),
  });
}
