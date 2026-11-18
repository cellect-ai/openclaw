/** Slack metadata so a Fi-originated answer is not mirrored back into the room. */
export const BOUND_SOURCE_REPLY_EVENT = "cellect_bound_source_reply";

export function isBoundSourceReply(message: { metadata?: { event_type?: string } }): boolean {
  return message.metadata?.event_type === BOUND_SOURCE_REPLY_EVENT;
}
