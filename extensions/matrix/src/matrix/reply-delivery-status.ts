import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export const MATRIX_REPLY_DELIVERY_KEY = "ai.cellect.reply_delivery";

export function parseMatrixReplyDeliveryStatus(value: unknown) {
  const record = asOptionalRecord(value);
  if (!record || record.version !== 1) return undefined;
  const id = record.triggerEventId;
  const triggerEventId = typeof id === "string" && /^\$[^\s]{1,254}$/u.test(id) ? id : undefined;
  if (record.state === "uncertain") {
    return { version: 1, state: record.state, ...(triggerEventId ? { triggerEventId } : {}) };
  }
  if (record.state === "resolved" && triggerEventId) {
    return { version: 1, state: record.state, triggerEventId };
  }
  return undefined;
}
