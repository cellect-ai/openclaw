import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { BOUND_SOURCE_REPLY_EVENT } from "./bound-source-reply-mark.js";
import { SLACK_MESSAGE_TEXT_HARD_LIMIT } from "./limits.js";
import { sendMessageSlack } from "./send.js";

export type BoundSourceReplyDelivery = {
  deliver: (params: {
    channelId: string;
    threadTs: string;
    text: string;
    idempotencyKey: string;
  }) => Promise<void>;
};

const MAX_DELIVERED_KEYS = 10_000;

export function createBoundSourceReplyDelivery(params: {
  cfg: OpenClawConfig;
  accountId: string;
}): BoundSourceReplyDelivery {
  const delivered = new Set<string>();
  return {
    deliver: async (input) => {
      const text = input.text.trim();
      const channelId = input.channelId.trim();
      const threadTs = input.threadTs.trim();
      if (
        !text ||
        !/^[CDG][A-Z0-9]+$/.test(channelId) ||
        !/^\d+\.\d+$/.test(threadTs) ||
        !input.idempotencyKey.trim()
      ) {
        return;
      }
      const chunks = splitBoundSourceReply(text);
      for (const [index, chunk] of chunks.entries()) {
        const key = `${input.idempotencyKey}:${index}`;
        if (delivered.has(key)) {
          continue;
        }
        if (delivered.size >= MAX_DELIVERED_KEYS) {
          delivered.clear();
        }
        delivered.add(key);
        try {
          await sendMessageSlack(channelId, chunk, {
            cfg: params.cfg,
            accountId: params.accountId,
            threadTs,
            textLimit: SLACK_MESSAGE_TEXT_HARD_LIMIT,
            deliveryQueueId: key,
            metadata: {
              event_type: BOUND_SOURCE_REPLY_EVENT,
              event_payload: { part: index, parts: chunks.length },
            },
          });
        } catch (error) {
          delivered.delete(key);
          throw error;
        }
      }
    },
  };
}

export function registerBoundSourceReplyDelivery(params: {
  channelRuntime?: Parameters<typeof registerChannelRuntimeContext>[0]["channelRuntime"];
  accountId: string;
  cfg: OpenClawConfig;
  abortSignal?: AbortSignal;
}): void {
  registerChannelRuntimeContext({
    channelRuntime: params.channelRuntime,
    channelId: "slack",
    accountId: params.accountId,
    capability: "bound-source-reply",
    context: createBoundSourceReplyDelivery({ cfg: params.cfg, accountId: params.accountId }),
    abortSignal: params.abortSignal,
  });
}

function splitBoundSourceReply(text: string): string[] {
  const limit = SLACK_MESSAGE_TEXT_HARD_LIMIT;
  if (text.length <= limit) {
    return [text];
  }
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += limit) {
    chunks.push(text.slice(offset, offset + limit));
  }
  return chunks;
}
