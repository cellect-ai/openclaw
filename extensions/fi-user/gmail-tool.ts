import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import { exchange, type Delegation, type ResolvedPluginConfig } from "./fi-delegation.js";
import { messageHeaderAddresses, requireMailbox, resultLimit, runGam } from "./gam.js";

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

export function createGmailTool(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext,
): AnyAgentTool {
  return {
    name: "fi_user_gmail",
    label: "My Gmail",
    description:
      "Search, read, draft, or send Gmail only as the current verified Cellect Fi requester. The mailbox is fixed by Fi membership and cannot be selected by the model. To file a read attachment into a project Library, use fi_user_dataroom action=upload_to_project_library, source=gmail, project, messageId and exact attachmentName; no data room or admin mailbox is required, and Fi checks your project grant. search_shared_inbox and read_shared_inbox reach the shared tenant inbox, limited to messages from, to or copied to the requester.",
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
