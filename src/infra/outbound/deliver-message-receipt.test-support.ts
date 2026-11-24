import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type { ChannelMessageSendResult } from "../../channels/message/types.js";

export function createMatrixMessageSendResult(
  messageId: string,
  kind: "media" | "text" = "text",
): ChannelMessageSendResult {
  return {
    messageId,
    receipt: createMessageReceiptFromOutboundResults({
      results: [{ channel: "matrix", messageId }],
      kind,
    }),
  };
}
