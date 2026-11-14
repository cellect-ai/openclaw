import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { beforeEach, expect, it, vi } from "vitest";
const { exchange, delegatedFetch } = vi.hoisted(() => ({
  exchange: vi.fn(),
  delegatedFetch: vi.fn(),
}));
vi.mock("./fi-delegation.js", () => ({
  exchange,
  delegatedFetch,
  readFiResponse: (r: Response) => r.json(),
}));
vi.mock("./mail-items-tool.js", () => ({
  mailItemsPrivateRoomId: (c: { nativeChannelId?: string }) => c.nativeChannelId,
}));
import { registerPersonalAgentContext } from "./personal-agent-context.js";
let hook: (...args: unknown[]) => Promise<unknown>, options: unknown;
const authority = { allows: () => true, assertActive: vi.fn() };
const context = () => ({
  agentId: "cellect-fi-user",
  runId: "run-1",
  sessionKey: "agent:cellect-fi-user:matrix:channel:!main:example.test",
  senderId: "@owner:example.test",
  channel: "matrix",
  chatId: "!main:example.test",
  accountId: "fiuserprod",
  toolAuthority: authority,
});
beforeEach(() => {
  vi.clearAllMocks();
  registerPersonalAgentContext({
    on: (_name: string, fn: typeof hook, opts: unknown) => {
      hook = fn;
      options = opts;
    },
  } as unknown as OpenClawPluginApi);
  exchange.mockResolvedValue({ config: {}, delegation: { user: { orgSlug: "shape" } } });
  delegatedFetch.mockImplementation(async () => Response.json({ enabled: true }));
});
it("refreshes enrollment at the actual prompt hook and instructs fresh sources before old choices", async () => {
  expect(options).toEqual({ requiresToolAuthority: true });
  const result = await hook({}, context());
  expect(result).toMatchObject({
    prependContext: expect.stringContaining("Refresh the relevant enrolled sources now"),
  });
  expect(delegatedFetch).toHaveBeenCalledTimes(1);
  expect(delegatedFetch.mock.calls[0]![2]).toBe("/api/shape/personal-agent/context");
  await hook({}, context());
  expect(exchange).toHaveBeenCalledTimes(2);
});
it("adds no private context in another room, missing sender, tool-denied or revoked enrollment", async () => {
  expect(await hook({}, { ...context(), senderId: undefined })).toBeUndefined();
  expect(await hook({}, { ...context(), channel: "slack" })).toBeUndefined();
  expect(
    await hook({}, { ...context(), toolAuthority: { ...authority, allows: () => false } }),
  ).toBeUndefined();
  delegatedFetch.mockResolvedValueOnce(Response.json({ enabled: false }));
  expect(await hook({}, context())).toBeUndefined();
  expect(exchange).toHaveBeenCalledTimes(1);
});
