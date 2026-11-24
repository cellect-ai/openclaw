import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { isShadowHookSessionKey } from "openclaw/plugin-sdk/session-key-runtime";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import { delegatedFetch, exchange, readFiResponse, requesterIdentity } from "./fi-delegation.js";

const MATRIX_ROOM_ID = /^![^\s:]+:[^\s]+$/;
const REVISION = /^[0-9]{1,19}$/;
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

const Schema = Type.Object(
  {
    action: Type.Union([Type.Literal("list"), Type.Literal("control")], {
      description: "list: the requester's own mail work items. control: change one of them.",
    }),
    itemId: Type.Optional(
      Type.String({ maxLength: 64, description: "Item id from list (control only)." }),
    ),
    control: Type.Optional(
      Type.Union(
        [
          Type.Literal("pause"),
          Type.Literal("drop"),
          Type.Literal("note"),
          Type.Literal("reprioritize"),
          Type.Literal("resume"),
        ],
        {
          description:
            "pause (optional until, reason), drop (optional reason), note (text), reprioritize (priority), resume.",
        },
      ),
    ),
    until: Type.Optional(Type.String({ format: "date-time" })),
    reason: Type.Optional(Type.String({ maxLength: 500 })),
    text: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
    priority: Type.Optional(Type.String({ maxLength: 8 })),
    expectedRevision: Type.Optional(
      Type.String({
        pattern: "^[0-9]{1,19}$",
        description: "The item's revision from list, as a decimal string.",
      }),
    ),
  },
  { additionalProperties: false },
);

type Input = {
  action: "list" | "control";
  itemId?: string;
  control?: "pause" | "drop" | "note" | "reprioritize" | "resume";
  until?: string;
  reason?: string;
  text?: string;
  priority?: string;
  expectedRevision?: string;
};

/** The strict body of Fi's `POST mail-agent/items/<id>/control`: only the fields its variant allows. */
function controlBody(input: Input): Record<string, unknown> {
  const allowed: Record<string, readonly (keyof Input)[]> = {
    pause: ["until", "reason"],
    drop: ["reason"],
    note: ["text"],
    reprioritize: ["priority"],
    resume: [],
  };
  const kind = input.control;
  if (!kind || !(kind in allowed)) {
    throw new Error("control requires one of pause, drop, note, reprioritize, resume");
  }
  if (
    input.expectedRevision !== undefined &&
    (typeof input.expectedRevision !== "string" || !REVISION.test(input.expectedRevision))
  ) {
    throw new Error("expectedRevision must be a decimal string of up to 19 digits");
  }
  const fields = allowed[kind]!;
  const extra = (["until", "reason", "text", "priority"] as const).filter(
    (key) => input[key] !== undefined && !fields.includes(key),
  );
  if (extra.length > 0) {
    throw new Error(`${kind} does not accept: ${extra.join(", ")}`);
  }
  if ((kind === "note" && !input.text) || (kind === "reprioritize" && !input.priority)) {
    throw new Error(`${kind} requires ${kind === "note" ? "text" : "priority"}`);
  }
  return {
    kind,
    ...Object.fromEntries(
      fields.flatMap((key) => (input[key] === undefined ? [] : [[key, input[key]]])),
    ),
    ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
  };
}

/**
 * The Matrix room of a turn admitted for its verified Matrix requester, or
 * undefined. Slack and webchat have no private-conversation proof Fi can verify.
 */
export function mailItemsPrivateRoomId(context: OpenClawPluginToolContext): string | undefined {
  if (
    isShadowHookSessionKey(context.sessionKey) ||
    context.messageChannel !== "matrix" ||
    requesterIdentity(context)?.channel !== "matrix"
  ) {
    return undefined;
  }
  const route = context.deliveryContext;
  if (route?.channel !== undefined && route.channel !== "matrix") {
    return undefined;
  }
  const routed = route?.to?.replace(/^room:/, "");
  const native = context.nativeChannelId;
  if (routed && native && routed !== native) {
    return undefined;
  }
  const roomId = routed || native;
  return roomId && MATRIX_ROOM_ID.test(roomId) ? roomId : undefined;
}

/**
 * Offered only in the requester's own Matrix conversation (Fi verifies it is
 * their private room); never in shared rooms, Slack or a background (shadow) run.
 */
export function offersMailItemsTool(context: OpenClawPluginToolContext): boolean {
  return mailItemsPrivateRoomId(context) !== undefined;
}

export function createMailItemsTool(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext,
): AnyAgentTool {
  return {
    name: "fi_user_mail_items",
    label: "Mail work items (as you)",
    description:
      "List the requester's own mail work items, or control one as the requester: pause, drop, note (an instruction for the next background pass), reprioritize, resume. Acts only with the requester's own Fi delegation; Fi enforces ownership and revisions.",
    parameters: Schema,
    async execute(_toolCallId, raw) {
      const input = raw as Input;
      const roomId = mailItemsPrivateRoomId(context);
      if (!roomId) {
        throw new Error("Mail work items are available only in your own private Fi conversation");
      }
      const { delegation, config } = await exchange(api, context, {
        privateConversation: { roomId },
      });
      const base = `/api/${encodeURIComponent(delegation.user.orgSlug)}/mail-agent/items`;
      if (input.action === "list") {
        const response = await delegatedFetch(config, delegation, base, {
          method: "GET",
          cache: "no-store",
        });
        const result = await readFiResponse(response);
        if (!response.ok) {
          throw new Error(
            `Fi returned ${response.status} for mail items: ${JSON.stringify(result).slice(0, 1_000)}`,
          );
        }
        return jsonResult({ status: response.status, result });
      }
      if (!input.itemId || !ITEM_ID.test(input.itemId)) {
        throw new Error("control requires the itemId returned by list");
      }
      const body = controlBody(input);
      const response = await delegatedFetch(
        config,
        delegation,
        `${base}/${encodeURIComponent(input.itemId)}/control`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const result = await readFiResponse(response);
      if (!response.ok) {
        throw new Error(
          `Fi returned ${response.status} for mail item control: ${JSON.stringify(result).slice(0, 1_000)}`,
        );
      }
      return jsonResult({ status: response.status, result });
    },
  };
}
