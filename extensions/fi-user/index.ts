import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { extractDocumentContent } from "openclaw/plugin-sdk/document-extractor";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult, type AgentToolResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import {
  adminActionSessions,
  adminHandoffBlock,
  createRequestAdminActionTool,
  handleAdminApprovalMessage,
} from "./admin-action.js";
import {
  projectSlackChannelThread,
  registerSlackChannelProjection,
  type SlackProjectionMessage,
  type SlackProjectionContext,
} from "./channel-projection-registration.js";
import { createDataRoomTool } from "./dataroom-tool.js";
import { isSlackDirectSessionKey } from "./direct-projection.js";
import { createFiUserApiTool } from "./fi-api-tool.js";
import {
  brokerToken,
  configFromRuntime,
  exchange,
  isFiUserTurn,
  rememberWebchatContext,
  type Delegation,
  type ResolvedPluginConfig,
} from "./fi-delegation.js";
import {
  downloadedFiles,
  driveExportArgs,
  driveFileMetadata,
  MAX_DRIVE_FILE_BYTES,
  messageHeaderAddresses,
  requireMailbox,
  resultLimit,
  runGam,
  type DriveFileMetadata,
} from "./gam.js";
import { createBudgetImportTool, createDeliverFileTool, createEsignTool } from "./member-tools.js";
import {
  ON_BEHALF_OF_AGENTS,
  ON_BEHALF_OF_TOOLS,
  onBehalfOfRequester,
  signOnBehalfOf,
  withOnBehalfOfEnv,
} from "./on-behalf-of.js";
import { projectionFailureKind } from "./projection-failure.js";
import { registerSourceReplyAuthorization } from "./source-reply-authorization.js";

const MAX_DRIVE_TEXT_CHARS = 200_000;
const SLACK_USER_ID = /^U[A-Z0-9]{8,}$/i;

/**
 * Mirror verified Slack channel threads into the Matrix room Fi authorizes for
 * their readers. Direct sessions use the canonical full-source snapshot path
 * registered with the Slack projection reconciler; do not infer their source
 * from a single message event. This is best-effort secondary delivery: an
 * unavailable Fi or Matrix path never delays Slack.
 */
async function projectVerifiedSlackMessage(
  api: OpenClawPluginApi,
  event: SlackProjectionMessage,
  context: SlackProjectionContext,
  projection: {
    retryChannelProjection: (sessionKey: string) => void;
    channelProjectionSucceeded: (sessionKey: string) => void;
  },
): Promise<void> {
  const sessionKey = event.sessionKey ?? context.sessionKey;
  const senderId = (event.senderId ?? context.senderId ?? "").trim().toUpperCase();
  if (context.channelId !== "slack" || !sessionKey || !SLACK_USER_ID.test(senderId)) {
    return;
  }
  if (isSlackDirectSessionKey(sessionKey)) {
    return;
  }

  const config = configFromRuntime(api);
  const token = brokerToken(config);
  if (!token) {
    api.logger.warn("fi-user: Slack projection skipped; broker is not configured");
    return;
  }

  try {
    if (context.accountId) {
      const projected = await projectSlackChannelThread({
        api,
        sessionKey,
        accountId: context.accountId,
        requesterSenderId: senderId,
        baseUrl: config.baseUrl,
        token,
      });
      if (projected) {
        projection.channelProjectionSucceeded(sessionKey);
      }
    }
  } catch (error) {
    api.logger.warn(
      `fi-user: Slack projection failed kind=${projectionFailureKind(error)} session=${sessionKey}`,
    );
    projection.retryChannelProjection(sessionKey);
  }
}

/**
 * The shared tenant inbox, narrowed to the requester's own correspondence:
 * every search is ANDed with from/to/cc the requester, and a message is read
 * only when its own From, To, Cc or Delivered-To header names one of the
 * requester's verified addresses exactly.
 */
async function searchOrReadSharedInbox(
  config: ResolvedPluginConfig,
  delegation: Delegation,
  input: { action: string; query?: string; maxResults?: number; messageId?: string },
) {
  const shared = config.sharedInboxMailbox;
  if (!shared) {
    throw new Error("The shared inbox is not available to Cellect Fi");
  }
  const requester = delegation.user.email.trim().toLowerCase();
  if (!/^[^\s@"()]+@[^\s@"()]+$/.test(requester)) {
    throw new Error("The requester has no usable email address");
  }
  if (input.action === "search_shared_inbox") {
    const query = input.query?.trim();
    if (!query) {
      throw new Error("query is required for search_shared_inbox");
    }
    // Grouping or OR could escape the requester clause; keep terms plain.
    if (/[(){}|]/.test(query) || /\bOR\b/.test(query)) {
      throw new Error(
        "search_shared_inbox takes plain search terms without OR, braces or parentheses",
      );
    }
    const output = await runGam(config, shared, [
      "print",
      "messages",
      "query",
      `{from:${requester} to:${requester} cc:${requester}} (${query})`,
      "max_to_print",
      resultLimit(input.maxResults),
    ]);
    return jsonResult({ mailbox: shared, scope: `from/to/cc ${requester}`, output });
  }
  if (!input.messageId) {
    throw new Error("messageId is required for read_shared_inbox");
  }
  // Headers only, no body: quoted headers in forwarded mail must not count.
  const headers = await runGam(config, shared, [
    "show",
    "messages",
    "ids",
    input.messageId,
    "headers",
    "from,to,cc,delivered-to",
  ]);
  const verified = new Set([requester]);
  if (delegation.gmail.enabled && delegation.gmail.mailbox) {
    verified.add(delegation.gmail.mailbox.trim().toLowerCase());
  }
  // Every message is delivered to the shared inbox; that address proves nothing.
  verified.delete(shared);
  const named = messageHeaderAddresses(headers);
  if (![...verified].some((address) => named.has(address))) {
    throw new Error("That shared-inbox message is not from, to, or copied to you");
  }
  const output = await runGam(config, shared, [
    "show",
    "messages",
    "ids",
    input.messageId,
    "showbody",
    "showattachments",
  ]);
  return jsonResult({ mailbox: shared, scope: `from/to/cc ${requester}`, output });
}

function mailArgs(input: {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
}): string[] {
  const args = ["to", input.to.join(","), "subject", input.subject, "textmessage", input.body];
  if (input.cc?.length) {
    args.push("cc", input.cc.join(","));
  }
  if (input.bcc?.length) {
    args.push("bcc", input.bcc.join(","));
  }
  return args;
}

const GmailSchema = Type.Object(
  {
    action: stringEnum([
      "search",
      "read",
      "draft",
      "send",
      "search_shared_inbox",
      "read_shared_inbox",
    ] as const),
    query: Type.Optional(Type.String({ maxLength: 1_000 })),
    maxResults: Type.Optional(
      Type.Integer({ minimum: 1, description: "Values above 50 are reduced to 50." }),
    ),
    messageId: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_-]+$" })),
    to: Type.Optional(Type.Array(Type.String({ format: "email" }), { minItems: 1, maxItems: 25 })),
    cc: Type.Optional(Type.Array(Type.String({ format: "email" }), { maxItems: 25 })),
    bcc: Type.Optional(Type.Array(Type.String({ format: "email" }), { maxItems: 25 })),
    subject: Type.Optional(Type.String({ maxLength: 500 })),
    body: Type.Optional(Type.String({ maxLength: 100_000 })),
    confirmSend: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

function createGmailTool(api: OpenClawPluginApi, context: OpenClawPluginToolContext): AnyAgentTool {
  return {
    name: "fi_user_gmail",
    label: "My Gmail",
    description:
      "Search, read, draft, or send Gmail only as the current verified Cellect Fi requester. The mailbox is fixed by Fi membership and cannot be selected by the model. search_shared_inbox and read_shared_inbox reach the shared tenant inbox, limited to messages from, to or copied to the requester.",
    parameters: GmailSchema,
    async execute(_toolCallId, raw) {
      const input = raw as {
        action: "search" | "read" | "draft" | "send" | "search_shared_inbox" | "read_shared_inbox";
        query?: string;
        maxResults?: number;
        messageId?: string;
        to?: string[];
        cc?: string[];
        bcc?: string[];
        subject?: string;
        body?: string;
        confirmSend?: boolean;
      };
      const { delegation, config } = await exchange(api, context);
      if (input.action === "search_shared_inbox" || input.action === "read_shared_inbox") {
        return searchOrReadSharedInbox(config, delegation, input);
      }
      const mailbox = requireMailbox(delegation);

      if (input.action === "search") {
        if (!input.query?.trim()) {
          throw new Error("query is required for search");
        }
        const output = await runGam(config, mailbox, [
          "print",
          "messages",
          "query",
          input.query.trim(),
          // `maxtoshow` belongs to `show messages`; `print messages` rejects it.
          "max_to_print",
          resultLimit(input.maxResults),
        ]);
        return jsonResult({ mailbox, output });
      }
      if (input.action === "read") {
        if (!input.messageId) {
          throw new Error("messageId is required for read");
        }
        const output = await runGam(config, mailbox, [
          "show",
          "messages",
          "ids",
          input.messageId,
          "showbody",
          "showattachments",
        ]);
        return jsonResult({ mailbox, output });
      }
      if (!input.to?.length || !input.subject || input.body === undefined) {
        throw new Error("to, subject, and body are required for draft/send");
      }
      if (input.action === "send" && input.confirmSend !== true) {
        throw new Error(
          "confirmSend=true is required after the requester explicitly approves sending",
        );
      }
      const args = mailArgs(
        input as Required<Pick<typeof input, "to" | "subject" | "body">> & typeof input,
      );
      const output =
        input.action === "draft"
          ? await runGam(config, mailbox, [
              "draft",
              "message",
              "textmessage",
              input.body,
              "to",
              input.to.join(","),
              "subject",
              input.subject,
              ...(input.cc?.length ? ["cc", input.cc.join(",")] : []),
              ...(input.bcc?.length ? ["bcc", input.bcc.join(",")] : []),
            ])
          : await runGam(config, mailbox, ["sendemail", ...args]);
      return jsonResult({ mailbox, action: input.action, output });
    },
  };
}

const GDriveSchema = Type.Object(
  {
    action: stringEnum(["search", "read"] as const),
    query: Type.Optional(Type.String({ maxLength: 1_000 })),
    maxResults: Type.Optional(
      Type.Integer({ minimum: 1, description: "Values above 50 are reduced to 50." }),
    ),
    fileId: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_-]+$" })),
    startPage: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
    maxPages: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    password: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false },
);

function isTextFile(metadata: DriveFileMetadata, filePath: string): boolean {
  return (
    metadata.mimeType.startsWith("text/") ||
    [".csv", ".html", ".json", ".md", ".txt", ".xml"].includes(path.extname(filePath).toLowerCase())
  );
}

async function readDriveFile(params: {
  config: ResolvedPluginConfig;
  mailbox: string;
  fileId: string;
  startPage: number;
  maxPages: number;
  password?: string;
}): Promise<AgentToolResult<Record<string, unknown>>> {
  const metadata = await driveFileMetadata(params.config, params.mailbox, params.fileId);
  if (metadata.mimeType === "application/vnd.google-apps.folder") {
    throw new Error("Folders cannot be read; search within the folder for files instead");
  }
  const declaredSize = metadata.size ? Number(metadata.size) : 0;
  if (Number.isFinite(declaredSize) && declaredSize > MAX_DRIVE_FILE_BYTES) {
    throw new Error(`Google Drive file exceeds the ${MAX_DRIVE_FILE_BYTES / 1024 / 1024} MB limit`);
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fi-user-drive-"));
  try {
    await runGam(params.config, params.mailbox, [
      "get",
      "drivefile",
      `id:${params.fileId}`,
      ...driveExportArgs(metadata.mimeType),
      "targetfolder",
      tempDir,
      "overwrite",
      "true",
      "showprogress",
      "false",
    ]);
    const files = await downloadedFiles(tempDir);
    const filePath = files[0];
    if (files.length !== 1 || !filePath) {
      throw new Error(`Expected one downloaded Drive file but found ${files.length}`);
    }
    const bytes = await fs.readFile(filePath);
    if (bytes.byteLength > MAX_DRIVE_FILE_BYTES) {
      throw new Error(
        `Google Drive file exceeds the ${MAX_DRIVE_FILE_BYTES / 1024 / 1024} MB limit`,
      );
    }

    if (
      metadata.mimeType === "application/pdf" ||
      path.extname(filePath).toLowerCase() === ".pdf"
    ) {
      const requestedPages = {
        start: params.startPage,
        end: params.startPage + params.maxPages - 1,
        continueWithStartPage: params.startPage + params.maxPages,
      };
      const pageNumbers = Array.from(
        { length: params.maxPages },
        (_, index) => params.startPage + index,
      );
      const extracted = await extractDocumentContent({
        buffer: bytes,
        mimeType: "application/pdf",
        maxPages: params.maxPages,
        maxPixels: 20_000_000,
        minTextChars: 1,
        pageNumbers,
        ...(params.password ? { password: params.password } : {}),
      });
      if (!extracted) {
        throw new Error("PDF extraction is unavailable");
      }
      const details = {
        mailbox: params.mailbox,
        file: metadata,
        extractedTextChars: extracted.text.length,
        extractedImageCount: extracted.images.length,
        extractor: extracted.extractor,
        requestedPages,
      };
      const content: AgentToolResult<typeof details>["content"] = [
        {
          type: "text",
          text: JSON.stringify(
            { mailbox: params.mailbox, file: metadata, requestedPages, text: extracted.text },
            null,
            2,
          ),
        },
        ...extracted.images,
      ];
      return { content, details };
    }

    if (
      metadata.mimeType === "application/vnd.google-apps.document" ||
      isTextFile(metadata, filePath)
    ) {
      if (params.startPage !== 1) {
        throw new Error("startPage is available only for PDF files");
      }
      const text = bytes.toString("utf8").slice(0, MAX_DRIVE_TEXT_CHARS);
      return jsonResult({ mailbox: params.mailbox, file: metadata, text });
    }
    throw new Error(
      `Reading ${metadata.mimeType} is not supported yet; use a PDF, Google Doc, or text file`,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function createGDriveTool(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext,
): AnyAgentTool {
  return {
    name: "fi_user_gdrive",
    label: "My Google Drive",
    description:
      "Search and read files only from the current verified Cellect Fi requester's Google Drive. The Drive identity is fixed by Fi membership and cannot be selected by the model. Search uses Google Drive query syntax and includes files shared with the requester. PDF reads are bounded page windows: use startPage to continue later sections and maxPages to control the window; a bounded result does not mean the source file is truncated.",
    parameters: GDriveSchema,
    async execute(_toolCallId, raw) {
      const input = raw as {
        action: "search" | "read";
        query?: string;
        maxResults?: number;
        fileId?: string;
        startPage?: number;
        maxPages?: number;
        password?: string;
      };
      const { delegation, config } = await exchange(api, context);
      const mailbox = requireMailbox(delegation, "Google Drive");
      if (input.action === "search") {
        if (!input.query?.trim()) {
          throw new Error("query is required for Drive search");
        }
        const output = await runGam(config, mailbox, [
          "print",
          "filelist",
          "anyowner",
          "query",
          input.query.trim(),
          "excludetrashed",
          "maxfiles",
          resultLimit(input.maxResults),
          "fields",
          "id,name,mimetype,size,modifiedtime,parents",
          "filepath",
        ]);
        return jsonResult({ mailbox, output });
      }
      if (!input.fileId) {
        throw new Error("fileId is required for Drive read");
      }
      return readDriveFile({
        config,
        mailbox,
        fileId: input.fileId,
        startPage: input.startPage ?? 1,
        maxPages: input.maxPages ?? 30,
        ...(input.password ? { password: input.password } : {}),
      });
    },
  };
}

export default definePluginEntry({
  id: "fi-user",
  name: "Fi User Delegation",
  description: "Requester-bound Gmail, Google Drive, and Fi operations",
  register(api) {
    const projectionConnection = () => {
      const config = configFromRuntime(api);
      return {
        baseUrl: config.baseUrl,
        token: brokerToken(config),
        fullRefreshesPerTick: config.projectionFullRefreshesPerTick,
      };
    };
    registerSourceReplyAuthorization(api, projectionConnection);
    const slackProjection = registerSlackChannelProjection(api, projectionConnection);
    api.on("message_received", async (event, context) => {
      slackProjection.noteInboundActivity({
        channelId: context.channelId,
        sessionKey: event.sessionKey ?? context.sessionKey,
        conversationId: context.conversationId,
      });
      if (context.channelId === "webchat") {
        rememberWebchatContext(event.sessionKey ?? context.sessionKey, event.content);
      }
      void handleAdminApprovalMessage(api, event, context).catch(() => {
        api.logger.warn("fi-user: admin approval handling failed");
      });
      // Keep source-channel delivery independent of Fi/Matrix latency.
      void projectVerifiedSlackMessage(api, event, context, slackProjection);
    });
    api.on("before_tool_call", (event, ctx) => {
      const config = configFromRuntime(api);
      const blocked = adminHandoffBlock(config, event, ctx);
      if (blocked) {
        return blocked;
      }
      if (!ON_BEHALF_OF_AGENTS.has(ctx.agentId ?? "") || !ON_BEHALF_OF_TOOLS.has(event.toolName)) {
        return undefined;
      }
      const secret = brokerToken(config);
      const requester = onBehalfOfRequester(
        ctx.requester,
        ctx.sessionKey ? adminActionSessions.get(ctx.sessionKey) : undefined,
      );
      const assertion =
        secret && requester && ctx.agentId
          ? signOnBehalfOf({ secret, agentId: ctx.agentId, requester })
          : undefined;
      return { params: withOnBehalfOfEnv(event.params, assertion) };
    });
    api.registerTool((context: OpenClawPluginToolContext) => {
      if (!isFiUserTurn(context)) {
        return null;
      }
      const tools = [
        createFiUserApiTool(api, context),
        createGmailTool(api, context),
        createGDriveTool(api, context),
        createDataRoomTool(api, context),
        createDeliverFileTool(api, context),
        createEsignTool(api, context),
        createBudgetImportTool(api, context),
        createRequestAdminActionTool(api, context),
      ];
      return tools;
    });
  },
});
