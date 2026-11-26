import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export const MATRIX_REPLY_DELIVERY_KEY = "ai.cellect.reply_delivery";

export function parseMatrixReplyDeliveryStatus(value: unknown) {
  const record = asOptionalRecord(value);
  if (!record || record.version !== 1) return undefined;
  const id = record.triggerEventId;
  const triggerEventId = typeof id === "string" && /^\$[^\s]{1,254}$/u.test(id) ? id : undefined;
  const deliveryId =
    typeof record.deliveryId === "string" && /^[A-Za-z0-9_.:-]{1,128}$/u.test(record.deliveryId)
      ? record.deliveryId
      : undefined;
  if (
    (id !== undefined && !triggerEventId) ||
    (record.deliveryId !== undefined && (!triggerEventId || !deliveryId))
  ) {
    return undefined;
  }
  const member = deliveryId ? { deliveryId } : {};
  if (record.state === "uncertain") {
    return {
      version: 1,
      state: record.state,
      ...(triggerEventId ? { triggerEventId } : {}),
      ...member,
    };
  }
  if (record.state === "resolved" && triggerEventId) {
    return { version: 1, state: record.state, triggerEventId, ...member };
  }
  return undefined;
}
