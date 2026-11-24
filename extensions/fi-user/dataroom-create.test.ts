import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRoom, type RoomCreationInput } from "./dataroom-create.js";
import { delegatedJson, type Delegation, type ResolvedPluginConfig } from "./fi-delegation.js";

vi.mock("./fi-delegation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./fi-delegation.js")>()),
  delegatedJson: vi.fn(),
}));

const request = {
  name: "Draw 3",
  scopeType: "project",
  scopeId: "project-1",
  kind: "draw",
  drawNumber: "3",
  creationKey: "draw-3-request-20261027",
} satisfies RoomCreationInput;
const room = {
  id: "created-1",
  name: "Draw 3",
  scopeType: "project",
  scopeId: "project-1",
  kind: "draw",
  status: "active",
  settings: { drawNumber: "3", status: "preparing", lenderName: null },
};
const ctx = {
  config: { baseUrl: "https://fi.example.test/fi" } as ResolvedPluginConfig,
  delegation: {
    user: { orgSlug: "shape", email: "member@example.com", role: "member" },
  } as Delegation,
  root: "/api/shape/datarooms",
  assertCurrent: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(delegatedJson).mockReset();
});

describe("requester-bound room creation", () => {
  it.each([
    { creationKey: undefined },
    { creationKey: "short" },
    { creationKey: "invalid/key-is-not-accepted" },
    { name: " " },
    { scopeType: "org" },
    { scopeId: "foreign:*" },
    { kind: "draw", scopeType: "company" },
    { drawNumber: undefined },
    { kind: "documents" },
  ])("rejects incomplete or invalid creation input before publication: %j", async (patch) => {
    await expect(createRoom(ctx, { ...request, ...patch } as RoomCreationInput)).rejects.toThrow();
    expect(delegatedJson).not.toHaveBeenCalled();
  });

  it("uses a stable key across retries, authenticates as the same requester, and checks readback", async () => {
    vi.mocked(delegatedJson).mockImplementation(async (_config, _delegation, _path, init) =>
      init?.method === "POST" ? { ok: true, room } : { room, roomVersion: 2 },
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(createRoom(ctx, request)).resolves.toMatchObject({
        room,
        roomVersion: 2,
        creationKey: request.creationKey,
        url: "https://fi.example.test/fi/shape/apps/data-rooms/created-1",
      });
    }
    const posts = vi.mocked(delegatedJson).mock.calls.filter((call) => call[3]?.method === "POST");
    expect(posts).toHaveLength(2);
    for (const post of posts) {
      expect(post[0]).toBe(ctx.config);
      expect(post[1]).toBe(ctx.delegation);
      expect(new Headers(post[3]?.headers).get("idempotency-key")).toBe(request.creationKey);
      expect(JSON.parse(typeof post[3]?.body === "string" ? post[3].body : "null")).toEqual({
        name: "Draw 3",
        scopeType: "project",
        scopeId: "project-1",
        kind: "draw",
        settings: { drawNumber: "3", status: "preparing", lenderName: null },
      });
    }
    expect(ctx.assertCurrent).toHaveBeenCalledTimes(2);
  });

  it("does not create under a stale invocation", async () => {
    const stale = {
      ...ctx,
      assertCurrent: () => {
        throw new Error("stale invocation");
      },
    };
    await expect(createRoom(stale, request)).rejects.toThrow("stale invocation");
    expect(delegatedJson).not.toHaveBeenCalled();
  });

  it.each([
    "id",
    "name",
    "scopeType",
    "scopeId",
    "kind",
    "status",
    "drawNumber",
    "drawStatus",
    "version",
  ])("does not report completion when readback differs in %s", async (field) => {
    const changed = {
      ...room,
      ...(field === "drawNumber"
        ? { settings: { ...room.settings, drawNumber: "4" } }
        : field === "drawStatus"
          ? { settings: { ...room.settings, status: "approved" } }
          : field === "version"
            ? {}
            : { [field]: "unexpected" }),
    };
    vi.mocked(delegatedJson)
      .mockResolvedValueOnce({ ok: true, room })
      .mockResolvedValueOnce({ room: changed, roomVersion: field === "version" ? 1 : 2 });
    await expect(createRoom(ctx, request)).rejects.toThrow(/same creationKey/);
  });

  it("does not follow an unconfirmed creation response with another creation", async () => {
    vi.mocked(delegatedJson).mockResolvedValueOnce({
      ok: true,
      room: { ...room, status: "provisioning" },
    });
    await expect(createRoom(ctx, request)).rejects.toThrow(/same creationKey/);
    expect(delegatedJson).toHaveBeenCalledTimes(1);
  });

  it("allows a documents room without draw or administrative settings", async () => {
    const documents = { ...room, name: "Diligence", kind: "documents", settings: {} };
    vi.mocked(delegatedJson)
      .mockResolvedValueOnce({ ok: true, room: documents })
      .mockResolvedValueOnce({ room: documents, roomVersion: 2 });
    await createRoom(ctx, {
      ...request,
      name: "Diligence",
      kind: "documents",
      drawNumber: undefined,
    });
    const serialized = vi.mocked(delegatedJson).mock.calls[0]?.[3]?.body;
    const body = JSON.parse(typeof serialized === "string" ? serialized : "null");
    expect(body).toEqual({
      name: "Diligence",
      scopeType: "project",
      scopeId: "project-1",
      kind: "documents",
      settings: {},
    });
  });
});
