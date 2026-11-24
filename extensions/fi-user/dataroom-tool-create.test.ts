import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { expect, it, vi } from "vitest";
import { createDataRoomTool } from "./dataroom-tool.js";
import { configFromRuntime, exchange } from "./fi-delegation.js";

vi.mock("./fi-delegation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./fi-delegation.js")>()),
  exchange: vi.fn(),
}));

it("the room tool creates with requester authentication, stable retry custody and verified readback", async () => {
  const api = createTestPluginApi({
    config: {
      plugins: { entries: { "fi-user": { config: { baseUrl: "https://fi.example.test/fi" } } } },
    },
  });
  vi.mocked(exchange).mockResolvedValue({
    config: configFromRuntime(api),
    identity: { channel: "slack", requesterSenderId: "U12345678" },
    delegation: {
      user: { email: "member@example.com", orgSlug: "shape", role: "member" },
      gmail: { enabled: false, mailbox: null },
      fi: { token: "requester-token", expiresAt: 1_900_000_000 },
    },
  });
  const room = {
    id: "new-room",
    name: "Draw 3",
    scopeType: "project",
    scopeId: "project-1",
    kind: "draw",
    status: "active",
    settings: { drawNumber: "3", status: "preparing", lenderName: null },
  };
  const requests: RequestInit[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      requests.push(init);
      const creation = init.method === "POST";
      expect(String(url)).toBe(
        `https://fi.example.test/fi/api/shape/datarooms${creation ? "" : "/new-room"}`,
      );
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer requester-token");
      return new Response(
        JSON.stringify(creation ? { ok: true, room } : { room, roomVersion: 2 }),
        { headers: { "content-type": "application/json" } },
      );
    }),
  );
  try {
    const result = await createDataRoomTool(api, {}).execute("create-1", {
      action: "create",
      name: "Draw 3",
      scopeType: "project",
      scopeId: "project-1",
      kind: "draw",
      drawNumber: "3",
      creationKey: "draw-3-create-request-1",
    });
    expect(requests).toHaveLength(2);
    expect(new Headers(requests[0]?.headers).get("idempotency-key")).toBe(
      "draw-3-create-request-1",
    );
    const body = requests[0]?.body;
    expect(JSON.parse(typeof body === "string" ? body : "null")).toEqual({
      name: "Draw 3",
      scopeType: "project",
      scopeId: "project-1",
      kind: "draw",
      settings: { drawNumber: "3", status: "preparing", lenderName: null },
    });
    expect(result.details).toMatchObject({
      room,
      roomVersion: 2,
      url: "https://fi.example.test/fi/shape/apps/data-rooms/new-room",
    });
  } finally {
    vi.unstubAllGlobals();
  }
});
