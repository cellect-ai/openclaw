/**
 * Where a request came from. A record stored before channels existed has no
 * `channel`; it is a Matrix origin. Neither shape carries an approval authority:
 * Fi decides who may decide, the origin only says where the requester is.
 */
export type MatrixAdminOrigin = {
  channel?: "matrix";
  orgId: string;
  roomId: string;
  threadRootEventId: string;
  agentMxid: string;
};
export type SlackAdminOrigin = {
  channel: "slack";
  orgId: string;
  accountId: string;
  channelId: string;
  /** Workspace of the verified Slack route, when the host names it. */
  teamId?: string;
  threadTs?: string;
  requesterSlackUserId: string;
};
export type AdminActionOrigin = MatrixAdminOrigin | SlackAdminOrigin;
export type SlackReviewerPublication = { slackUserId: string; channelId: string; ts: string };

/** A record stored before channels existed has no `channel`; it is a Matrix origin. */
export function sameAdminOrigin(
  a: AdminActionOrigin | undefined,
  b: AdminActionOrigin | undefined,
) {
  const tag = (origin: AdminActionOrigin | undefined) =>
    origin && !origin.channel ? { channel: "matrix", ...origin } : origin;
  return JSON.stringify(tag(a)) === JSON.stringify(tag(b));
}

export function isSlackOrigin(origin: AdminActionOrigin | undefined): origin is SlackAdminOrigin {
  return origin?.channel === "slack";
}

/** What a requester is told when they retry a request that already exists. */
export function existingRequestNote(origin: AdminActionOrigin | undefined): string {
  return isSlackOrigin(origin)
    ? "The existing request is with the organization's administrators in Slack. No link or payment was created."
    : "The existing approval card is posted in this conversation. No link or payment was created.";
}
