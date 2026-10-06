import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/document-extractor", () => ({ extractDocumentContent: vi.fn() }));

import fiUserPlugin from "./index.js";

type ToolFactory = (context: OpenClawPluginToolContext) => AnyAgentTool | AnyAgentTool[] | null;

const runtimeConfig = {
  plugins: {
    entries: {
      "fi-user": {
        config: {
          baseUrl: "https://fi.example.test",
          brokerTokenEnv: "TEST_BROKER_TOKEN",
          tenantOrgId: "org-shape",
        },
      },
    },
  },
};

/** Fi's delegation endpoint knows exactly one Matrix member. */
const LINKED_SPEAKER = "@alex:threads.example";
const calls: Array<{ url: string; init: RequestInit }> = [];

/**
 * A bound realtime voice consult as the Gateway runs it: on the Matrix thread,
 * with the speaker Fi attested for the Talk binding as the run's sender.
 */
function voiceTools(requesterSenderId: string | undefined): AnyAgentTool[] {
  const registrations: Array<AnyAgentTool | ToolFactory> = [];
  fiUserPlugin.register?.(
    createTestPluginApi({
      id: "fi-user",
      name: "Fi User Delegation",
      config: runtimeConfig,
      runtime: {
        channel: { runtimeContexts: { register: vi.fn() } },
      } as unknown as OpenClawPluginApi["runtime"],
      registerTool: (tool) => registrations.push(tool as AnyAgentTool | ToolFactory),
    }),
  );
  const factory = registrations[0] as ToolFactory;
  const result = factory({
    agentId: "cellect-fi-user",
    messageChannel: "matrix",
    agentAccountId: "fi-user",
    requesterSenderId,
    sessionKey: "agent:cellect-fi-user:matrix:channel:!room:threads.example:thread:$root",
    getRuntimeConfig: () => runtimeConfig,
  } as OpenClawPluginToolContext);
  return result ? (Array.isArray(result) ? result : [result]) : [];
}

function fiUserApi(requesterSenderId: string): AnyAgentTool {
  const tool = voiceTools(requesterSenderId).find((candidate) => candidate.name === "fi_user_api");
  if (!tool) {
    throw new Error("missing fi_user_api");
  }
  return tool;
}

function delegationRequest() {
  const call = calls.find((entry) => entry.url.endsWith("/api/openclaw-user-delegation"));
  return JSON.parse(typeof call?.init.body === "string" ? call.init.body : "null");
}

describe("fi-user on a realtime voice consult", () => {
  beforeEach(() => {
    vi.stubEnv("TEST_BROKER_TOKEN", "broker-token");
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ "fi-user": "prod" }));
    calls.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init: RequestInit = {}) => {
        const url = new URL(input);
        calls.push({ url: url.href, init });
        if (url.pathname === "/api/openclaw-user-delegation") {
          const body = JSON.parse(typeof init.body === "string" ? init.body : "{}") as {
            requesterMatrixUserId?: string;
          };
          return body.requesterMatrixUserId === LINKED_SPEAKER
            ? Response.json({
                user: {
                  email: "alex@example.com",
                  orgSlug: "shape",
                  orgId: "org-shape",
                  role: "admin",
                },
                gmail: { enabled: false, mailbox: null },
                fi: { token: "delegated-token", expiresAt: 1_900_000_000 },
              })
            : new Response("not found", { status: 404 });
        }
        if (url.pathname === "/api/shape/82-sussex/budget/text") {
          return new Response("budget");
        }
        return new Response("unexpected", { status: 599 });
      }),
    );
  });

  it("reads Fi as the attested speaker, with the speaker's own delegated token", async () => {
    const result = await fiUserApi(LINKED_SPEAKER).execute("v1", {
      path: "82-sussex/budget/text",
    });
    expect(result.details).toMatchObject({ status: 200, result: "budget" });
    expect(delegationRequest()).toEqual({
      requesterMatrixUserId: LINKED_SPEAKER,
      agentId: "cellect-fi-user",
    });
    const read = calls.find((entry) => entry.url.endsWith("/82-sussex/budget/text"));
    expect(new Headers(read?.init.headers).get("authorization")).toBe("Bearer delegated-token");
  });

  it("offers no Fi tools without an attested speaker", () => {
    expect(voiceTools(undefined)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it.each([
    "openclaw-control-ui",
    "@alex",
    "alex:threads.example",
    "@alex:threads.example @lorenzo:threads.example",
  ])("offers no Fi tools to the malformed speaker %s", (sender) => {
    expect(voiceTools(sender)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("rejects a speaker Fi does not link to an active member before reading Fi", async () => {
    await expect(
      fiUserApi("@stranger:threads.example").execute("v2", { path: "82-sussex/budget/text" }),
    ).rejects.toThrow("not linked to an active Fi member");
    expect(delegationRequest()).toEqual({
      requesterMatrixUserId: "@stranger:threads.example",
      agentId: "cellect-fi-user",
    });
    expect(calls).toHaveLength(1);
  });
});
