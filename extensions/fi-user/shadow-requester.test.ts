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

type ToolRegistration = AnyAgentTool | ToolFactory | { contextVersion: 2; create: ToolFactory };

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

const ATTESTATION = `fsa:job-1:${"A".repeat(43)}`;
const calls: Array<{ url: string; init: RequestInit }> = [];

/** A Fi-user tool context as the host builds it for a cron or hook run. */
function shadowTools(extra: Record<string, unknown>): AnyAgentTool[] {
  const registrations: ToolRegistration[] = [];
  fiUserPlugin.register?.(
    createTestPluginApi({
      id: "fi-user",
      name: "Fi User Delegation",
      config: runtimeConfig,
      runtime: {
        channel: { runtimeContexts: { register: vi.fn() } },
      } as unknown as OpenClawPluginApi["runtime"],
      registerTool: (tool) => registrations.push(tool as ToolRegistration),
    }),
  );
  // Native 10.4 registers a version-2 descriptor ({ contextVersion: 2, create })
  // rather than a bare v1 factory (see OpenClawPluginToolFactory in
  // src/plugins/tool-types.ts); resolve the factory by its real contract.
  const registration = registrations[0];
  if (!registration) {
    throw new Error("expected fi-user tool registration");
  }
  const factory =
    typeof registration === "function"
      ? registration
      : "create" in registration
        ? registration.create
        : () => registration;
  const result = (factory as ToolFactory)({
    agentId: "cellect-fi-user",
    getRuntimeConfig: () => runtimeConfig,
    ...extra,
  } as OpenClawPluginToolContext);
  return result ? (Array.isArray(result) ? result : [result]) : [];
}

const SHADOW_SESSION = "agent:cellect-fi-user:hook:fi-shadow:abc123";

function delegationRequest() {
  const call = calls.find((entry) => entry.url.endsWith("/api/openclaw-user-delegation"));
  return JSON.parse(typeof call?.init.body === "string" ? call.init.body : "null");
}

describe("fi-user on a Fi shadow hook turn", () => {
  beforeEach(() => {
    vi.stubEnv("TEST_BROKER_TOKEN", "broker-token");
    calls.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init: RequestInit = {}) => {
        const url = new URL(input);
        calls.push({ url: url.href, init });
        if (url.pathname === "/api/openclaw-user-delegation") {
          const body = JSON.parse(typeof init.body === "string" ? init.body : "{}") as {
            shadowAttestation?: string;
          };
          return body.shadowAttestation === ATTESTATION
            ? Response.json({
                user: {
                  email: "a@example.com",
                  orgSlug: "shape",
                  orgId: "org-shape",
                  role: "user",
                },
                gmail: { enabled: false, mailbox: null },
                fi: { token: "delegated-token", expiresAt: 1_900_000_000 },
              })
            : new Response("not found", { status: 404 });
        }
        return new Response("ok");
      }),
    );
  });

  it("admits the user-tier shadow run and asks Fi with the attestation alone", async () => {
    const tools = shadowTools({
      sessionKey: SHADOW_SESSION,
      hookRequesterAttestation: ATTESTATION,
    });
    const api = tools.find((tool) => tool.name === "fi_user_api");
    expect(tools.map((tool) => tool.name)).toEqual(["fi_user_api"]);
    const result = await api?.execute("s1", { path: "82-sussex/budget/text" });
    expect(result?.details).toMatchObject({ status: 200 });
    expect(delegationRequest()).toEqual({
      shadowAttestation: ATTESTATION,
      sessionKey: SHADOW_SESSION,
      agentId: "cellect-fi-user",
    });
  });

  it("never offers the mail item control tool to a shadow run, and offers it to a normal user turn", () => {
    const shadow = shadowTools({
      sessionKey: SHADOW_SESSION,
      hookRequesterAttestation: ATTESTATION,
    });
    expect(shadow.map((tool) => tool.name)).toEqual(["fi_user_api"]);
    const normal = shadowTools({
      sessionKey: "agent:cellect-fi-user:webchat:abc",
      messageChannel: "webchat",
    });
    expect(normal.map((tool) => tool.name)).toContain("fi_user_mail_items");
  });

  it.each([
    ["no attestation", { sessionKey: SHADOW_SESSION }],
    [
      "an attestation on a non-shadow session",
      {
        sessionKey: "agent:cellect-fi-user:cron:job",
        hookRequesterAttestation: ATTESTATION,
      },
    ],
    [
      "a malformed attestation",
      { sessionKey: SHADOW_SESSION, hookRequesterAttestation: "fsa:x:short" },
    ],
    ["an ordinary cron run", { sessionKey: "agent:cellect-fi-user:cron:job", trigger: "cron" }],
    [
      "a shared-mail hook",
      { sessionKey: "agent:cellect-fi-user:hook:fi-mail:abc", trigger: "cron" },
    ],
  ])("offers no Fi tools for %s", (_name, extra) => {
    expect(shadowTools(extra)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("does not admit another agent's shadow run", () => {
    expect(
      shadowTools({
        agentId: "some-other-agent",
        sessionKey: "agent:some-other-agent:hook:fi-shadow:abc123",
        hookRequesterAttestation: ATTESTATION,
      }),
    ).toEqual([]);
  });
});
