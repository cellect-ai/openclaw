/**
 * request_admin_action task `room_admin`: a data-room administration notice
 * (members, recipients, public links, settings). It is posted for an admin to
 * act on in Fi; it is not an approval request and holds nothing a reply or a
 * later call could carry out.
 */
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import type { AdminActionFields } from "./admin-action.js";
import { delegatedFetch, type exchange } from "./fi-delegation.js";

/** The only fields a room_admin notice carries: what to change, never a change itself. */
const ROOM_ADMIN_FIELDS = new Set([
  "task",
  "description",
  "project",
  "roomId",
  "roomChange",
  "reason",
]);
export const ROOM_ADMIN_CHANGES = {
  members: "members",
  recipients: "recipients",
  public_links: "public links",
  settings: "settings",
} as const;
/** Sessions already asked which project a room_admin notice is for: ask once, then file. */
const roomAdminProjectAsked = new Set<string>();
export type RoomAdminChange = keyof typeof ROOM_ADMIN_CHANGES;
/** Notices one conversation may post: a loop or a flood stops here. */
export const ROOM_ADMIN_NOTICES_PER_SESSION = 3;
const roomAdminNoticeCount = new Map<string, number>();
const NOTICE_FIELD_CHARS = 300;

/**
 * A requester-supplied value as inert notice text: one line, at most 300
 * characters, `& < >` escaped (Slack reads `<!channel>`, `<@U…>` and
 * `<url|text>` only unescaped) and `@room`/`@channel`/`@here`/`@everyone`
 * broken with a zero-width space, so the notice cannot ping, link or forge
 * a line for the admins who read it.
 */
export function noticeText(value: string): string {
  const line = value
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const capped =
    line.length > NOTICE_FIELD_CHARS ? `${line.slice(0, NOTICE_FIELD_CHARS - 1)}…` : line;
  return capped
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@(room|channel|here|everyone)\b/gi, "@\u200b$1");
}

/** A room_admin call carries what to change, never a change: anything else is refused. */
export function assertRoomAdminNotice(input: object): void {
  const extra = Object.keys(input).filter((key) => !ROOM_ADMIN_FIELDS.has(key));
  if (extra.length > 0) {
    throw new Error(
      `room_admin is a notice only: it asks an administrator to act in Fi and carries no membership, recipient, link or settings change. Remove: ${extra.join(", ")}.`,
    );
  }
}

/** The Fi project bound to the current Slack channel, when Fi names exactly one. */
async function boundProject(
  context: OpenClawPluginToolContext,
  exchanged: Awaited<ReturnType<typeof exchange>>,
): Promise<string | undefined> {
  const channel = context.nativeChannelId?.trim() ?? "";
  if (context.messageChannel !== "slack" || !/^[CG][A-Z0-9]{6,}$/i.test(channel)) {
    return undefined;
  }
  const { config, delegation } = exchanged;
  try {
    const response = await delegatedFetch(
      config,
      delegation,
      `/api/${encodeURIComponent(delegation.user.orgSlug)}/slack-channels/${encodeURIComponent(channel)}/project`,
      { method: "GET", cache: "no-store" },
    );
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    return /^project_slug:\s*(\S+)\s*$/m.exec(await response.text())?.[1];
  } catch {
    return undefined;
  }
}

/**
 * A data-room administration notice: members, recipients, public links or
 * settings. Posted for an admin to act on in Fi; it is not an approval request
 * and holds nothing a reply or a later call could carry out. Without a project
 * or room, the channel's bound project is used; with none, the requester is
 * asked once, then the notice is filed without one rather than looping.
 */
export async function roomAdminNotice(
  context: OpenClawPluginToolContext,
  fields: AdminActionFields,
  exchanged: Awaited<ReturnType<typeof exchange>>,
) {
  const { config, delegation, identity } = exchanged;
  let project = fields.project?.trim() || undefined;
  if (!project && !fields.roomId) {
    project = await boundProject(context, exchanged);
    const asked = context.sessionKey ?? "";
    if (!project && asked && !roomAdminProjectAsked.has(asked)) {
      if (roomAdminProjectAsked.size >= 1_000) {
        roomAdminProjectAsked.clear();
      }
      roomAdminProjectAsked.add(asked);
      return jsonResult({
        status: "needs_project",
        cardPosted: false,
        tellRequester:
          "Ask once which project (or data room) this is for, then call again with project. Nothing was filed.",
      });
    }
  }
  const session = context.sessionKey ?? "";
  const sent = roomAdminNoticeCount.get(session) ?? 0;
  if (sent >= ROOM_ADMIN_NOTICES_PER_SESSION) {
    return jsonResult({
      status: "notice_limit",
      cardPosted: false,
      tellRequester: `${ROOM_ADMIN_NOTICES_PER_SESSION} data-room notices were already sent from this conversation. Nothing more was filed; ask an administrator in Fi directly.`,
    });
  }
  const principals = config.adminPrincipals.map((id) =>
    /^U[A-Z0-9]+$/i.test(id) ? `<@${id}>` : id,
  );
  const who =
    identity.channel === "slack" ? `<@${identity.requesterSenderId}>` : delegation.user.email;
  const text = [
    `Data-room change requested by ${who} (${delegation.user.email})${fields.roomChange ? `: ${ROOM_ADMIN_CHANGES[fields.roomChange]}` : ""}`,
    `Project: ${project ? noticeText(project) : "not given"}`,
    fields.roomId ? `Data room: ${noticeText(fields.roomId)}` : undefined,
    `What: ${noticeText(fields.description ?? "")}`,
    fields.reason ? `Why: ${noticeText(fields.reason)}` : undefined,
    `${principals.join(" ")}${principals.length ? " — " : ""}please make this change in Fi (the data room's members, recipients, links or settings). This is a notice only: replying here approves or changes nothing.`,
  ]
    .filter(Boolean)
    .join("\n");
  if (context.delivery) {
    await context.delivery.send({ text });
  }
  if (roomAdminNoticeCount.size >= 1_000 && !roomAdminNoticeCount.has(session)) {
    roomAdminNoticeCount.clear();
  }
  roomAdminNoticeCount.set(session, sent + 1);
  return jsonResult({
    filed: true,
    notifyOnly: true,
    ...(context.delivery ? { cardPosted: true } : { cardPosted: false, postThisVerbatim: text }),
    tellRequester:
      "An administrator was asked to make this change in Fi. Nothing was changed, and this request cannot change room members, recipients, links or settings.",
  });
}
