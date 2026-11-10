import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { isShadowHookSessionKey } from "openclaw/plugin-sdk/session-key-runtime";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import { delegatedFetch, exchange, readFiResponse } from "./fi-delegation.js";

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
    text: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
    priority: Type.Optional(Type.String({ maxLength: 8 })),
    expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
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
  expectedRevision?: number;
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

/** Never offered to a background (shadow) run: it may read items, not steer them. */
export function offersMailItemsTool(context: OpenClawPluginToolContext): boolean {
  return !isShadowHookSessionKey(context.sessionKey);
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
      const { delegation, config } = await exchange(api, context);
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
