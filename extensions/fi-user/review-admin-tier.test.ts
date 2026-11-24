import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/document-extractor", () => ({
  extractDocumentContent: vi.fn(),
}));

import { exchange } from "./fi-delegation.js";
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
const ATTESTATION = `pra:job-1:${"A".repeat(43)}`;
const KEY = `hook:fi-review:${"a".repeat(40)}`;
const REVIEW_JWT = "aaaa.bbbb.cccc";
const calls: Array<{ url: string; init: RequestInit }> = [];
let grantAgentId: string | undefined;

function context(agentId: string, extra: Record<string, unknown> = {}) {
  return {
    agentId,
    runId: "run-1",
    sessionKey: KEY,
    hookRequesterAttestation: ATTESTATION,
    assertInvocationCurrent: () => {},
    getRuntimeConfig: () => runtimeConfig,
    ...extra,
  } as unknown as OpenClawPluginToolContext<2>;
}
function api() {
  return createTestPluginApi({
    id: "fi-user",
    name: "Fi User Delegation",
    config: runtimeConfig,
    runtime: {
      config: { current: () => runtimeConfig },
      channel: { runtimeContexts: { register: vi.fn() } },
    } as unknown as OpenClawPluginApi["runtime"],
    registerTool: () => {},
  });
}
function tools(ctx: OpenClawPluginToolContext): AnyAgentTool[] {
  const registrations: Array<{ create: ToolFactory }> = [];
  fiUserPlugin.register?.({
    ...api(),
    registerTool: (tool: unknown) => registrations.push(tool as { create: ToolFactory }),
  } as OpenClawPluginApi);
  const result = registrations[0]!.create(ctx);
  return result ? (Array.isArray(result) ? result : [result]) : [];
}

beforeEach(() => {
  vi.stubEnv("TEST_BROKER_TOKEN", "broker-token");
  calls.length = 0;
  grantAgentId = "cellect-fi-admin";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(input);
      calls.push({ url: url.href, init });
      if (url.pathname === "/api/personal-agent/background-grant") {
        return Response.json({
          ok: true,
          user: {
            email: "o@example.com",
            orgSlug: "shape",
            orgId: "org-shape",
            role: "admin",
          },
          requester: {
            channel: "personal-agent-review",
            email: "o@example.com",
          },
          fi: {
            token: REVIEW_JWT,
            expiresAt: Math.floor(Date.now() / 1000) + 600,
          },
          review: {
            profile: {},
            roomId: "!main:example.test",
            jobId: "job-1",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            ...(grantAgentId ? { agentId: grantAgentId } : {}),
          },
        });
      }
      if (url.pathname.endsWith("/admin-operations")) {
        return Response.json({ ok: true, operations: [], nextOffset: null });
      }
      return Response.json({ ok: true });
    }),
  );
});
afterEach(() => vi.unstubAllEnvs());

describe("admin-tier personal review run", () => {
  it("gives a user review run no admin tools", () => {
    const names = tools(context("cellect-fi-user")).map((t) => t.name);
    expect(names).toContain("fi_user_review_report");
    expect(names).not.toContain("fi_admin_operation");
    expect(names).not.toContain("fi_workbook");
  });

  it("gives an admin review run the personal tools plus the admin operation tool and workbook", () => {
    const names = tools(context("cellect-fi-admin")).map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "fi_user_work_items",
        "fi_user_review_report",
        "fi_admin_operation",
        "fi_workbook",
      ]),
    );
  });

  it("refuses any other agent, and a missing or mismatched attestation", () => {
    expect(tools(context("cellect-main"))).toEqual([]);
    expect(tools(context("cellect-fi-admin", { hookRequesterAttestation: undefined }))).toEqual([]);
    expect(
      tools(
        context("cellect-fi-admin", {
          sessionKey: `agent:cellect-fi-user:${KEY}`,
        }),
      ),
    ).toEqual([]);
  });

  it("calls Fi's admin operations with the review's own token", async () => {
    const tool = tools(context("cellect-fi-admin")).find((t) => t.name === "fi_admin_operation")!;
    await tool.execute("1", { action: "discover" }, undefined as never);
    const call = calls.find((c) => c.url.includes("/admin-operations"))!;
    expect(new Headers(call.init.headers).get("authorization")).toBe(`Bearer ${REVIEW_JWT}`);
    expect(calls.some((c) => c.url.endsWith("/api/openclaw-user-delegation"))).toBe(false);
  });

  it("sends nothing when Fi's grant names another agent or none", async () => {
    const tool = tools(context("cellect-fi-admin")).find((t) => t.name === "fi_admin_operation")!;
    for (const agent of ["cellect-fi-user", undefined]) {
      grantAgentId = agent;
      await expect(tool.execute("1", { action: "discover" }, undefined as never)).rejects.toThrow(
        "does not match this agent",
      );
    }
    expect(calls.some((c) => c.url.includes("/admin-operations"))).toBe(false);
  });
});

describe("review grant agent check", () => {
  it("accepts a legacy user grant with no agent and refuses a user run granted as admin", async () => {
    grantAgentId = undefined;
    await expect(exchange(api(), context("cellect-fi-user"))).resolves.toBeTruthy();
    grantAgentId = "cellect-fi-admin";
    await expect(exchange(api(), context("cellect-fi-user"))).rejects.toThrow(
      "does not match this agent",
    );
    grantAgentId = "cellect-fi-user";
    await expect(exchange(api(), context("cellect-fi-user"))).resolves.toBeTruthy();
  });
});
