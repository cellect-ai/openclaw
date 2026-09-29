import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";

export const MAX_SLACK_FILE_BYTES = 50 * 1024 * 1024;
const SLACK_API = "https://slack.com/api";
const SLACK_FILE_ID = /^F[A-Z0-9]{6,}$/;
const SLACK_SESSION =
  /^agent:[^:]+:slack:(channel|group|direct):([a-z0-9]+)(?::thread:(\d+\.\d+))?$/i;

export type SlackConversation = {
  kind: "channel" | "group" | "direct";
  channelId: string;
  threadTs?: string;
};

type SlackShare = { ts?: string; thread_ts?: string };
export type SlackFileInfo = {
  id: string;
  name?: string;
  title?: string;
  user?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
  permalink?: string;
  shares?: {
    public?: Record<string, SlackShare[]>;
    private?: Record<string, SlackShare[]>;
  };
};

/** The Slack conversation of this turn, from the host-owned session and route. */
export function slackConversation(context: OpenClawPluginToolContext): SlackConversation | null {
  if (context.messageChannel !== "slack") {
    return null;
  }
  const match = SLACK_SESSION.exec(context.sessionKey ?? "");
  const kind = match?.[1]?.toLowerCase() as SlackConversation["kind"] | undefined;
  const nativeChannel = context.nativeChannelId?.trim().toUpperCase();
  // A direct session key names the peer, not the DM channel; only the host's
  // native conversation id identifies the DM itself.
  const channelId =
    kind === "direct" ? nativeChannel : (nativeChannel ?? match?.[2]?.toUpperCase());
  if (!kind || !channelId || !/^[CGD][A-Z0-9]{6,}$/.test(channelId)) {
    return null;
  }
  const threadTs = match?.[3];
  return { kind, channelId, ...(threadTs ? { threadTs } : {}) };
}

/** The bot token of the Slack account this agent speaks through. */
export function slackBotToken(context: OpenClawPluginToolContext): string | undefined {
  const cfg = (context.getRuntimeConfig?.() ?? context.runtimeConfig ?? context.config) as
    | {
        channels?: {
          slack?: { botToken?: unknown; accounts?: Record<string, { botToken?: unknown }> };
        };
      }
    | undefined;
  const slack = cfg?.channels?.slack;
  const accountId = context.agentAccountId ?? context.deliveryContext?.accountId;
  const token = (accountId && slack?.accounts?.[accountId]?.botToken) || slack?.botToken;
  return typeof token === "string" && token.trim() ? token.trim() : undefined;
}

async function slackGet<T>(
  token: string,
  method: string,
  params: Record<string, string>,
): Promise<T> {
  const response = await fetch(`${SLACK_API}/${method}?${new URLSearchParams(params)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string } & T;
  if (!response.ok || body.ok !== true) {
    throw new Error(`Slack ${method} failed: ${body.error ?? response.status}`);
  }
  return body;
}

function sharedHere(file: SlackFileInfo, conversation: SlackConversation): boolean {
  const shares = [
    ...(file.shares?.public?.[conversation.channelId] ?? []),
    ...(file.shares?.private?.[conversation.channelId] ?? []),
  ];
  if (shares.length === 0) {
    return false;
  }
  if (!conversation.threadTs) {
    return true;
  }
  return shares.some(
    (share) => share.thread_ts === conversation.threadTs || share.ts === conversation.threadTs,
  );
}

/**
 * Resolve one file the requester posted in this conversation. A file id is
 * checked, not trusted: Slack must report the requester as its uploader and a
 * share of it in this channel (and this thread, for a thread session).
 */
export async function resolveRequesterSlackFile(params: {
  token: string;
  conversation: SlackConversation;
  requesterSenderId: string;
  fileId?: string;
  fileName?: string;
}): Promise<SlackFileInfo> {
  const requester = params.requesterSenderId.toUpperCase();
  let candidates: SlackFileInfo[];
  if (params.fileId) {
    const fileId = params.fileId.trim().toUpperCase();
    if (!SLACK_FILE_ID.test(fileId)) {
      throw new Error("fileId must be a Slack file id (F…)");
    }
    const info = await slackGet<{ file: SlackFileInfo }>(params.token, "files.info", {
      file: fileId,
    });
    candidates = [info.file];
  } else if (params.fileName?.trim()) {
    const listed = await slackGet<{ files?: SlackFileInfo[] }>(params.token, "files.list", {
      channel: params.conversation.channelId,
      user: requester,
      count: "100",
    });
    const wanted = params.fileName.trim().toLowerCase();
    candidates = (listed.files ?? []).filter(
      (file) => file.name?.toLowerCase() === wanted || file.title?.toLowerCase() === wanted,
    );
    // Listing entries omit thread shares; re-read the newest match in full.
    if (candidates[0]) {
      candidates = [
        (
          await slackGet<{ file: SlackFileInfo }>(params.token, "files.info", {
            file: candidates[0].id,
          })
        ).file,
      ];
    }
  } else {
    throw new Error("Provide fileId or fileName of the Slack file");
  }
  const file = candidates[0];
  if (!file) {
    throw new Error("No file by that name was posted by you in this conversation");
  }
  if (file.user?.toUpperCase() !== requester) {
    throw new Error("That Slack file was not posted by you");
  }
  if (!sharedHere(file, params.conversation)) {
    throw new Error("That Slack file was not posted in this conversation");
  }
  return file;
}

export async function downloadSlackFile(token: string, file: SlackFileInfo): Promise<Uint8Array> {
  const url = file.url_private_download ?? file.url_private;
  if (!url || !url.startsWith("https://files.slack.com/")) {
    throw new Error("Slack did not return a downloadable file URL");
  }
  if (typeof file.size === "number" && file.size > MAX_SLACK_FILE_BYTES) {
    throw new Error(`Slack file exceeds the ${MAX_SLACK_FILE_BYTES / 1024 / 1024} MB limit`);
  }
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new Error(`Slack file download failed (${response.status})`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_SLACK_FILE_BYTES) {
    throw new Error(`Slack file exceeds the ${MAX_SLACK_FILE_BYTES / 1024 / 1024} MB limit`);
  }
  // A login page instead of the file means the token lacks files:read.
  if ((response.headers.get("content-type") ?? "").includes("text/html")) {
    throw new Error("Slack returned a login page instead of the file");
  }
  return bytes;
}
