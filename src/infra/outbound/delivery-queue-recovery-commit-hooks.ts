import type {
  ChannelMessageSendCommitContext,
  ChannelMessageUnknownSendReconciliationResult,
} from "../../channels/message/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../errors.js";
import { resolveOutboundChannelMessageAdapter } from "./channel-resolution.js";
import { buildReconciledSentResult } from "./delivery-queue-reconciliation.js";
import type { RecoveryLogger } from "./delivery-queue-recovery.js";
import type { QueuedDelivery } from "./delivery-queue-types.js";
import { preparedOutboundPayloads } from "./prepared-batch.js";

export async function runReconciledSentCommitHooks(params: {
  entry: QueuedDelivery;
  cfg: OpenClawConfig;
  reconciliation: Extract<ChannelMessageUnknownSendReconciliationResult, { status: "sent" }>;
  log: RecoveryLogger;
  assertCurrent: () => void;
}): Promise<void> {
  if (params.entry.legacyPreparedContentUnavailable) {
    return;
  }
  const adapter = await resolveOutboundChannelMessageAdapter({
    channel: params.entry.channel,
    cfg: params.cfg,
    agentId: params.entry.session?.agentId,
    allowBootstrap: true,
    assertCurrent: params.assertCurrent,
  });
  params.assertCurrent();
  const afterCommit = adapter?.send?.lifecycle?.afterCommit;
  if (!afterCommit) {
    return;
  }
  const result = buildReconciledSentResult(params.entry, params.reconciliation);
  try {
    const { entry } = params;
    const payload = preparedOutboundPayloads(entry.preparedBatch)[0] ?? {};
    const base = {
      cfg: params.cfg,
      to: entry.to,
      deliveryQueueId: entry.id,
      accountId: entry.accountId,
      replyToId:
        entry.effectiveReplyToId !== undefined ? entry.effectiveReplyToId : entry.reply?.replyToId,
      replyToMode: entry.reply?.source === "implicit" ? entry.reply.mode : undefined,
      threadId: entry.threadId,
      silent: entry.silent,
      text: payload.text ?? "",
      result: {
        messageId: result.messageId,
        receipt: result.receipt,
      },
    };
    let context: ChannelMessageSendCommitContext;
    if (
      payload.presentation !== undefined ||
      payload.delivery !== undefined ||
      payload.interactive !== undefined ||
      (payload.channelData !== undefined && Object.keys(payload.channelData).length > 0)
    ) {
      context = { ...base, kind: "payload", mediaUrl: payload.mediaUrl, payload };
    } else {
      const mediaUrl = payload.mediaUrl ?? payload.mediaUrls?.find((url) => url);
      context = mediaUrl
        ? {
            ...base,
            kind: "media",
            mediaUrl,
            audioAsVoice: payload.audioAsVoice,
            gifPlayback: entry.gifPlayback,
            forceDocument: entry.forceDocument,
          }
        : { ...base, kind: "text" };
    }
    await afterCommit(context);
  } catch (err) {
    params.log.warn(
      `Delivery entry ${params.entry.id} reconciled sent afterCommit hook failed: ${formatErrorMessage(err)}`,
    );
  }
}
