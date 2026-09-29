// Fi user delegation tests cover Matrix environment routing behavior.
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { expect, it, vi } from "vitest";

type Route = (url: URL, init: RequestInit) => Response | Promise<Response> | undefined;

/**
 * The Matrix environment suite runs inside tools.test.ts, whose file-scoped
 * `vi.mock` declarations own the plugin's module graph; it borrows that file's
 * fetch stub and plugin factory rather than standing up a second one.
 */
export type FiUserMatrixEnvironmentHarness = {
  BROKER: string;
  authorization: (init: RequestInit) => string | null;
  calls: Array<{ url: string; init: RequestInit }>;
  context: (overrides?: Partial<OpenClawPluginToolContext>) => OpenClawPluginToolContext;
  delegationBody: () => unknown;
  json: (body: unknown, status?: number) => Response;
  plugin: () => { tool: (name: string, toolContext: OpenClawPluginToolContext) => AnyAgentTool };
  routes: Route[];
};

export function registerFiUserMatrixEnvironmentTests(harness: FiUserMatrixEnvironmentHarness) {
  const { BROKER, authorization, calls, context, delegationBody, json, plugin, routes } = harness;
  it.each([
    { accountId: "fi-user", origin: "https://fi.example.test", broker: BROKER },
    { accountId: "fi-user-dev", origin: "https://dev-fi.example.test", broker: "dev-broker-token" },
  ])(
    "uses the $accountId environment for Matrix delegation and subsequent API calls",
    async ({ accountId, origin, broker }) => {
      routes.push((url) =>
        url.pathname === "/api/shape/documents/search" ? json({ results: [] }) : undefined,
      );
      await plugin()
        .tool(
          "fi_user_api",
          context({
            messageChannel: "matrix",
            agentAccountId: accountId,
            requesterSenderId: "@member:threads.example",
            sessionKey: "agent:cellect-fi-user:matrix:room:!abc",
          }),
        )
        .execute("c2", { path: "/api/shape/documents/search", query: { q: "title commitment" } });
      expect(delegationBody()).toEqual({
        requesterMatrixUserId: "@member:threads.example",
        agentId: "cellect-fi-user",
      });
      const delegationCall = calls.find((call) =>
        call.url.endsWith("/api/openclaw-user-delegation"),
      );
      expect(delegationCall?.url).toBe(`${origin}/api/openclaw-user-delegation`);
      expect(authorization(delegationCall!.init)).toBe(`Bearer ${broker}`);
      expect(
        calls.some(
          (entry) => entry.url === `${origin}/api/shape/documents/search?q=title+commitment`,
        ),
      ).toBe(true);
    },
  );

  it.each([
    { label: "missing account", accountId: undefined, delivery: undefined },
    { label: "unknown account", accountId: "unknown", delivery: undefined },
    {
      label: "conflicting route",
      accountId: "fi-user-dev",
      delivery: { channel: "matrix", accountId: "fi-user" },
    },
    {
      label: "wrong fallback channel",
      accountId: undefined,
      delivery: { channel: "slack", accountId: "fi-user" },
    },
  ])("refuses Matrix $label before delegation", async ({ accountId, delivery }) => {
    await expect(
      plugin()
        .tool(
          "fi_user_api",
          context({
            messageChannel: "matrix",
            requesterSenderId: "@member:threads.example",
            agentAccountId: accountId,
            deliveryContext: delivery,
          }),
        )
        .execute("bad", { path: "/api/shape/documents/search" }),
    ).rejects.toThrow(/Matrix.*(environment|route)/);
    expect(calls).toEqual([]);
  });

  it("uses a trusted Matrix delivery account when the requester account is absent", async () => {
    routes.push((url) =>
      url.pathname === "/api/shape/documents/search" ? json({ results: [] }) : undefined,
    );
    await plugin()
      .tool(
        "fi_user_api",
        context({
          messageChannel: "matrix",
          requesterSenderId: "@member:threads.example",
          agentAccountId: undefined,
          deliveryContext: { channel: "matrix", accountId: "fi-user-dev" },
        }),
      )
      .execute("fallback", { path: "/api/shape/documents/search" });
    expect(calls.every((call) => call.url.startsWith("https://dev-fi.example.test/"))).toBe(true);
  });

  it.each(["invalid-json", JSON.stringify({ "fi-user-dev": "unconfigured" })])(
    "does not use prod for an unusable Matrix environment map",
    async (map) => {
      vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", map);
      await expect(
        plugin()
          .tool(
            "fi_user_api",
            context({
              messageChannel: "matrix",
              requesterSenderId: "@member:threads.example",
              agentAccountId: "fi-user-dev",
            }),
          )
          .execute("unconfigured", { path: "/api/shape/documents/search" }),
      ).rejects.toThrow("Matrix account environment is not configured");
      expect(calls).toEqual([]);
    },
  );
}
