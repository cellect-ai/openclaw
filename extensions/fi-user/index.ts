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
import { registerAdminActionRpc } from "./admin-action-rpc.js";
import {
  adminActionSessions,
  adminHandoffBlock,
  createRequestAdminActionTool,
  decideAdminApproval,
} from "./admin-action.js";
import { registerAdminDelegation } from "./admin-delegation.js";
import { createAdminOperationTool } from "./admin-operation-tool.js";
import { projectSlackChannelThread } from "./channel-projection-publisher.js";
import {
  registerSlackChannelProjection,
  type SlackProjectionMessage,
  type SlackProjectionContext,
} from "./channel-projection-registration.js";
import { createDataRoomTool } from "./dataroom-tool.js";
import { isSlackDirectSessionKey } from "./direct-projection.js";
import { createEsignTool } from "./esign-tool.js";
import { createFiUserApiTool } from "./fi-api-tool.js";
import {
  brokerToken,
  configFromRuntime,
  isAdminAgent,
  exchange,
  FI_ADMIN_DELEGATION_AGENT_ID,
  isFiUserShadowTurn,
  isFiUserTurn,
  rememberWebchatContext,
  type ResolvedPluginConfig,
} from "./fi-delegation.js";
import {
  downloadedFiles,
  driveExportArgs,
  driveFileMetadata,
  MAX_DRIVE_FILE_BYTES,
  requireMailbox,
  resultLimit,
  runGam,
  type DriveFileMetadata,
} from "./gam.js";
import { registerGeneratedArtifactCompletion } from "./generated-artifact-completion.js";
import {
  registerFileArtifactRuntime,
  withoutInternalDownloadLinks,
} from "./generated-artifacts.js";
import { createGmailTool } from "./gmail-tool.js";
import { registerLetMeKnow } from "./let-me-know.js";
import { createMailItemsTool, offersMailItemsTool } from "./mail-items-tool.js";
import { registerMatrixEntitlements } from "./matrix-entitlements.js";
import { createBudgetImportTool, createDeliverFileTool } from "./member-tools.js";
import {
  ON_BEHALF_OF_AGENTS,
  ON_BEHALF_OF_TOOLS,
  mailWakeRequester,
  onBehalfOfRequester,
  signOnBehalfOf,
  withOnBehalfOfEnv,
} from "./on-behalf-of.js";
import { registerPersonalAgentContext } from "./personal-agent-context.js";
import { createPersonalAgentTools } from "./personal-agent-tools.js";
import { projectionFailureKind } from "./projection-failure.js";
import { createReadConversationTool, registerReadConversationCap } from "./read-conversation.js";
import { reviewRunClaimed, reviewToolAttestation } from "./review-requester.js";
import { registerSourceReplyAuthorization } from "./source-reply-authorization.js";
import { createWorkbookTool } from "./workbook-tool.js";
import { delegatedWorkbookTransport, matrixWorkbookTransport } from "./workbook-transport.js";

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
    registerAdminActionRpc(api);
    registerGeneratedArtifactCompletion(api);
    api.on("reply_payload_sending", (event, context) => {
      if (
        !(event.sessionKey ?? context.sessionKey)?.startsWith("agent:cellect-fi-user:") ||
        !event.payload.text
      ) {
        return undefined;
      }
      const text = withoutInternalDownloadLinks(event.payload.text);
      return text === event.payload.text ? undefined : { payload: { ...event.payload, text } };
    });
    api.on("message_sending", (event, context) => {
      if (!context.sessionKey?.startsWith("agent:cellect-fi-user:")) {
        return undefined;
      }
      const content = withoutInternalDownloadLinks(event.content);
      return content === event.content ? undefined : { content };
    });
    const matrixEntitlements = registerMatrixEntitlements(api);
    registerLetMeKnow(api);
    const adminDelegation = registerAdminDelegation(
      api,
      matrixEntitlements.admittedVoiceTurn,
      matrixEntitlements.admittedOperatorCommand,
    );
    registerFileArtifactRuntime(api, {
      // The configured Fi-admin only: another admin runtime has no import path here.
      isAdminAgent: (agentId) =>
        agentId?.toLowerCase() === FI_ADMIN_DELEGATION_AGENT_ID &&
        agentId.toLowerCase() === configFromRuntime(api).adminAgentId.toLowerCase(),
      provenToolRequester: adminDelegation.provenToolRequester,
    });
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
      adminDelegation.received({
        channel: context.channelId,
        senderId: event.senderId ?? context.senderId,
        sessionKey: event.sessionKey ?? context.sessionKey,
        channelContext: context.channelContext,
        messageId: event.messageId ?? context.messageId,
        accountId: context.accountId,
        conversationId: context.conversationId,
        threadId: event.threadId,
      });
      if (context.channelId === "webchat") {
        rememberWebchatContext(event.sessionKey ?? context.sessionKey, event.content);
      }
      // Keep source-channel delivery independent of Fi/Matrix latency.
      void projectVerifiedSlackMessage(api, event, context, slackProjection);
    });
    // The host asks before it injects a channel message into the run already
    // active in its session; a claim queues the message as its own turn.
    api.on("before_steer", (event, context) => {
      const message = {
        channel: context.channelId ?? event.channel,
        senderId: event.senderId ?? context.senderId,
        sessionKey: event.sessionKey ?? context.sessionKey,
        channelContext: context.channelContext,
        messageId: event.messageId ?? context.messageId,
        accountId: context.accountId,
        conversationId: context.conversationId,
      };
      // The host reports back when it could not queue what this hook claimed.
      if (event.queueRefused === true) {
        adminDelegation.steerRefused(message);
        return undefined;
      }
      return adminDelegation.steerGate(message) ? { handled: true } : undefined;
    });
    // An approver's reply to an admin-action card is decided here and claimed,
    // so the same text is not also run as an agent turn. message_received only
    // observes: handling it there left "approve <ID>" to reach the model too.
    api.on(
      "before_dispatch",
      async (event, context) => {
        const message = {
          senderId: event.senderId ?? context.senderId,
          senderAuthentication: event.senderAuthentication,
          sessionKey: event.sessionKey ?? context.sessionKey,
          channelContext: context.channelContext,
        };
        const channel = context.channelId ?? event.channel;
        try {
          const outcome = await decideAdminApproval(
            api,
            { content: event.content, ...message },
            { channelId: channel, sessionKey: context.sessionKey },
          );
          if (outcome.claimed) {
            return { handled: true, ...(outcome.text ? { text: outcome.text } : {}) };
          }
        } catch {
          api.logger.warn("fi-user: admin approval handling failed");
        }
        // Only a message that goes on to the agent can start or join its turn.
        adminDelegation.dispatched({
          channel,
          isGroup: event.isGroup,
          messageId: event.messageId,
          ...(context.accountId ? { accountId: context.accountId } : {}),
          ...message,
        });
        return undefined;
      },
      { priority: 10_000 },
    );
    registerPersonalAgentContext(api);
    const conversationReadCap = registerReadConversationCap(api);
    api.on(
      "before_tool_call",
      (event, ctx) => {
        // The host's deadline for this hook runs from here, across the grant check below.
        const enteredAt = Date.now();
        const readCap = conversationReadCap(event.toolName, ctx);
        if (readCap) {
          return readCap;
        }
        const authorizeAndAttribute = () => {
          const config = configFromRuntime(api);
          const blocked = adminHandoffBlock(config, event, ctx);
          if (blocked) {
            return blocked;
          }
          const held = adminDelegation.held(config, event.toolName, ctx);
          // crossChannelCustody: such a call may still ask Fi, but runs only
          // with a token minted for the holder's own subject; else it is held.
          if (held && !adminDelegation.decidesAfterMint(config, event.toolName, ctx)) {
            return held;
          }
          // The assertion is for the agents Fi's on-behalf-of knows by name; the
          // delegated token is for whichever agent is this runtime's admin tier.
          const attributed = ON_BEHALF_OF_AGENTS.has(ctx.agentId ?? "");
          if (
            !(attributed || isAdminAgent(config, ctx.agentId)) ||
            !ON_BEHALF_OF_TOOLS.has(event.toolName)
          ) {
            return undefined;
          }
          const secret = brokerToken(config);
          const adminAction = ctx.sessionKey ? adminActionSessions.get(ctx.sessionKey) : undefined;
          const requester = adminAction
            ? onBehalfOfRequester(ctx.requester, adminAction)
            : (mailWakeRequester(ctx.sessionKey, ctx.requester?.senderId) ??
              onBehalfOfRequester(ctx.requester));
          const assertion =
            attributed && secret && requester && ctx.agentId
              ? signOnBehalfOf({ secret, agentId: ctx.agentId, requester })
              : undefined;
          // Same-environment operator calls retain the assertion-only fallback.
          // A selected different environment must either get its token or block.
          const delegated = adminDelegation.mint(config, event, ctx, enteredAt);
          if (held) {
            return delegated
              ? delegated.then((minted) =>
                  minted && !("block" in minted)
                    ? { params: withOnBehalfOfEnv(event.params, assertion, minted) }
                    : held,
                )
              : held;
          }
          return delegated
            ? delegated.then((minted) =>
                minted && "block" in minted
                  ? minted
                  : { params: withOnBehalfOfEnv(event.params, assertion, minted) },
              )
            : { params: withOnBehalfOfEnv(event.params, assertion) };
        };
        const authorized = matrixEntitlements.beforeToolCall(ctx);
        return authorized instanceof Promise
          ? authorized.then((denied) => denied ?? authorizeAndAttribute())
          : (authorized ?? authorizeAndAttribute());
      },
      { priority: 10_000 },
    );
    api.registerTool({
      contextVersion: 2,
      create: (context: OpenClawPluginToolContext<2>) => {
        if (reviewRunClaimed(context)) {
          return reviewToolAttestation(context) ? createPersonalAgentTools(api, context) : null;
        }
        // Inbound email is untrusted and the turn reads private data, so a
        // shadow turn only reads Fi as its member: nothing that sends, shares,
        // signs or writes. Its mailbox tools belong to the requester plugin.
        if (isFiUserShadowTurn(context)) {
          return [createFiUserApiTool(api, context)];
        }
        const conversationReader = createReadConversationTool(
          api,
          context,
          adminDelegation.provenToolRequester,
        );
        const conversationTools = conversationReader ? [conversationReader] : [];
        const workbookTurn = matrixEntitlements.workbookTurn(context);
        const workbookTransport = workbookTurn
          ? matrixWorkbookTransport(api, workbookTurn)
          : delegatedWorkbookTransport(api, context, adminDelegation.provenToolRequester);
        const workbookTools = workbookTransport
          ? [createWorkbookTool(context, workbookTransport)]
          : [];
        if (
          context.agentId?.toLowerCase() === FI_ADMIN_DELEGATION_AGENT_ID &&
          context.agentId.toLowerCase() === configFromRuntime(api).adminAgentId.toLowerCase()
        ) {
          return [
            ...conversationTools,
            ...workbookTools,
            createAdminOperationTool(context, () => adminDelegation.provenToolRequester(context)),
          ];
        }
        if (!isFiUserTurn(context)) {
          return [...conversationTools, ...workbookTools].length
            ? [...conversationTools, ...workbookTools]
            : null;
        }
        const tools = [
          ...workbookTools,
          createFiUserApiTool(api, context),
          createGmailTool(api, context),
          createGDriveTool(api, context),
          createDataRoomTool(api, context),
          createDeliverFileTool(api, context),
          createEsignTool(api, context),
          createBudgetImportTool(api, context),
          createRequestAdminActionTool(api, context),
          ...(offersMailItemsTool(context) ? [createMailItemsTool(api, context)] : []),
          ...createPersonalAgentTools(api, context),
        ];
        return tools;
      },
    });
  },
});
