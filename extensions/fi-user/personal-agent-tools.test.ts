import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  mailItemsPrivateRoomId: (c: { messageChannel?: string }) =>
    c.messageChannel === "matrix" ? "!main:example.test" : undefined,
}));
import { createPersonalAgentTools } from "./personal-agent-tools.js";
const api = {} as OpenClawPluginApi;
const review: OpenClawPluginToolContext = {
  agentId: "cellect-fi-user",
  runId: "run-1",
  sessionKey: `hook:fi-review:${"a".repeat(40)}`,
  hookRequesterAttestation: `pra:job-1:${"B".repeat(43)}`,
};
beforeEach(() => {
  vi.clearAllMocks();
  exchange.mockResolvedValue({
    config: {},
    delegation: { user: { email: "owner@example.test", orgSlug: "shape" } },
  });
  delegatedFetch.mockImplementation(async () => Response.json({ ok: true }));
});
const tool = (name: string) => createPersonalAgentTools(api, review).find((t) => t.name === name)!;
describe("personal review tools", () => {
  it("fills the current owner and dispatches the actual operation envelope", async () => {
    await tool("fi_user_work_items").execute("call-1", {
      action: "list",
      input: { statuses: ["open"], limit: 20 },
    });
    expect(delegatedFetch).toHaveBeenCalledWith(
      {},
      expect.anything(),
      "/api/shape/work-item/list",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          input: { statuses: ["open"], limit: 20, actor: "owner@example.test" },
        }),
      }),
    );
    await expect(
      tool("fi_user_work_items").execute("call-2", {
        action: "capture",
        input: { actor: "other@example.test" },
      }),
    ).rejects.toThrow("actor argument");
  });
  it("refuses background enrollment changes and malformed host context", async () => {
    await expect(
      tool("fi_user_agent_profile").execute("call-1", { action: "configure", input: {} }),
    ).rejects.toThrow("interactive");
    expect(
      createPersonalAgentTools(api, { ...review, hookRequesterAttestation: undefined }),
    ).toEqual([]);
    expect(createPersonalAgentTools(api, { ...review, runId: undefined })).toEqual([]);
  });
  it("does not wrap direct report/source contracts as operation envelopes", async () => {
    const report = { disposition: "silent", text: "", sourceStatus: [] };
    await tool("fi_user_review_report").execute("call-1", report);
    expect(delegatedFetch.mock.calls[0][2]).toBe("/api/shape/personal-agent/report");
    expect(JSON.parse(delegatedFetch.mock.calls[0][3].body)).toEqual(report);
  });
  it("fills a stable per-turn source request id instead of a model-selected one", async () => {
    const context = { ...review, runId: "e4e3c1ef-5853-41f5-b9ce-0e302545b7db" };
    const source = createPersonalAgentTools(api, context).find(
      (t) => t.name === "fi_user_review_sources",
    )!;
    await source.execute("call-1", { sourceId: "agents", requestId: "caller-selected" });
    await source.execute("call-2", { sourceId: "agents" });
    expect(JSON.parse(delegatedFetch.mock.calls[0][3].body)).toEqual({
      sourceId: "agents",
      requestId: `${context.runId}:agents`,
    });
    expect(delegatedFetch.mock.calls[0][3].body).toBe(delegatedFetch.mock.calls[1][3].body);
  });
});
