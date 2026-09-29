import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import { delegatedFetch, exchange, readFiResponse } from "./fi-delegation.js";

/**
 * Read endpoints fi-user may call, relative to `/api/<requester org>/`. This
 * mirrors Fi's own delegation allowlist (`src/lib/openclaw/user-delegation.ts`)
 * so a request Fi would refuse is refused here first, with a clearer message.
 * Each Fi handler still enforces the requester's own project and app grants.
 */
export const FI_USER_API_READ_ROUTES: readonly RegExp[] = [
  /^[^/]+\/(?:budget|cash-flows|cash-flow-statement|financing|milestones|payments|docs)\/text$/,
  /^apps\/accounts-payable\/text$/,
  /^documents\/search$/,
  /^slack-channels\/[^/]+\/project$/,
];

const MAX_TEXT_CHARS = 200_000;
const MAX_QUERY_PARAMS = 20;

/** Normalize a model-supplied path to one reviewed org-relative read route. */
export function fiUserApiPath(orgSlug: string, requested: string): string {
  let relative = requested.trim().replace(/^\/+/, "");
  relative = relative.replace(/^fi\//, "");
  const orgPrefix = `api/${orgSlug}/`;
  if (relative.startsWith("api/")) {
    if (!relative.startsWith(orgPrefix)) {
      throw new Error("Only the requester's own Fi organization is available");
    }
    relative = relative.slice(orgPrefix.length);
  }
  if (relative.includes("?") || relative.includes("#")) {
    throw new Error("Pass query parameters in `query`, not in `path`");
  }
  const segments = relative.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..") ||
    /%2e|%2f|%5c|\\/i.test(relative)
  ) {
    throw new Error("path must be a Fi API path without empty or traversal segments");
  }
  if (!FI_USER_API_READ_ROUTES.some((route) => route.test(relative))) {
    throw new Error(
      "That Fi endpoint is not available to fi_user_api. Available: <project>/{budget,cash-flows,cash-flow-statement,financing,milestones,payments,docs}/text, apps/accounts-payable/text, documents/search, slack-channels/<channel>/project",
    );
  }
  return `/api/${encodeURIComponent(orgSlug)}/${relative}`;
}

const ApiSchema = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      maxLength: 500,
      description:
        "Org-relative Fi read route, e.g. `305-third/budget/text`, `apps/accounts-payable/text`, `documents/search`, `slack-channels/C0123/project`.",
    }),
    query: Type.Optional(
      Type.Record(Type.String({ maxLength: 64 }), Type.String({ maxLength: 500 }), {
        description: "Query parameters, e.g. { q: 'title commitment', project: '82-sussex' }.",
      }),
    ),
  },
  { additionalProperties: false },
);

export function createFiUserApiTool(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext,
): AnyAgentTool {
  return {
    name: "fi_user_api",
    label: "Fi (as you)",
    description:
      "Read Fi as the current verified requester (GET only): project text views (budget, cash flows, financing, milestones, payments, document library), the AP text view, document search, and which project a Slack channel is bound to. Fi applies the requester's own project and app grants; a 403/404 means they do not hold that grant.",
    parameters: ApiSchema,
    async execute(_toolCallId, raw) {
      const input = raw as { path: string; query?: Record<string, string> };
      const { delegation, config } = await exchange(api, context);
      const pathname = fiUserApiPath(delegation.user.orgSlug, input.path);
      const entries = Object.entries(input.query ?? {});
      if (entries.length > MAX_QUERY_PARAMS) {
        throw new Error(`At most ${MAX_QUERY_PARAMS} query parameters`);
      }
      const search = new URLSearchParams(entries).toString();
      const response = await delegatedFetch(
        config,
        delegation,
        search ? `${pathname}?${search}` : pathname,
        { method: "GET" },
      );
      const result = await readFiResponse(response);
      const body =
        typeof result === "string" && result.length > MAX_TEXT_CHARS
          ? `${result.slice(0, MAX_TEXT_CHARS)}\n…[truncated]`
          : result;
      if (!response.ok) {
        throw new Error(
          `Fi returned ${response.status} for ${pathname}: ${
            typeof body === "string" ? body.slice(0, 1_000) : JSON.stringify(body).slice(0, 1_000)
          }`,
        );
      }
      return jsonResult({ status: response.status, path: pathname, result: body });
    },
  };
}
