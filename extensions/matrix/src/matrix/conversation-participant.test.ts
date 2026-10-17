import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  members: vi.fn(),
  self: vi.fn(),
  whoami: vi.fn(),
  client: vi.fn(),
}));
vi.mock("./send/client.js", () => ({ withResolvedMatrixSendClient: mocks.client }));
import { isJoinedMatrixMember } from "./conversation-participant.js";

function request() {
  return {
    cfg: {},
    accountId: "bot-account",
    expectedAccountUserId: "@bot:matrix.test",
    groupId: "!room:matrix.test",
    userId: "@person:matrix.test",
    assertCurrent: vi.fn(),
  };
}
describe("native Matrix control participant proof", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.members.mockResolvedValue(["@bot:matrix.test", "@person:matrix.test"]);
    mocks.self.mockResolvedValue("@bot:matrix.test");
    mocks.whoami.mockResolvedValue({ user_id: "@bot:matrix.test" });
    mocks.client.mockImplementation(async (_opts, callback) =>
      callback({
        getJoinedRoomMembers: mocks.members,
        getUserId: mocks.self,
        doRequest: mocks.whoami,
      }),
    );
  });

  it("uses the exact selected account and native room membership", async () => {
    const input = request();
    await expect(isJoinedMatrixMember(input)).resolves.toBe(true);
    expect(mocks.client).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: input.cfg,
        accountId: input.accountId,
        assertDirectAdapterHandoff: input.assertCurrent,
      }),
      expect.any(Function),
    );
    expect(mocks.members).toHaveBeenCalledWith(input.groupId);
  });

  it("returns false for an absent person without inventing membership", async () => {
    mocks.members.mockResolvedValue(["@bot:matrix.test"]);
    await expect(isJoinedMatrixMember(request())).resolves.toBe(false);
  });

  it.each(["misbound-token", "missing-identity", "rejected-token"])(
    "refuses %s despite cached bot identity",
    async (kind) => {
      if (kind === "misbound-token") {
        mocks.whoami.mockResolvedValue({ user_id: "@other:matrix.test" });
      }
      if (kind === "missing-identity") {
        mocks.whoami.mockResolvedValue({});
      }
      if (kind === "rejected-token") {
        mocks.whoami.mockRejectedValue(new Error("invalid token"));
      }
      await expect(isJoinedMatrixMember(request())).rejects.toThrow();
    },
  );

  it.each(["malformed", "foreign-bot", "native-error", "revoked"])(
    "refuses %s proof",
    async (kind) => {
      const input = request();
      if (kind === "malformed") {
        mocks.members.mockResolvedValue({ joined: {} });
      }
      if (kind === "foreign-bot") {
        mocks.members.mockResolvedValue([input.userId]);
      }
      if (kind === "native-error") {
        mocks.members.mockRejectedValue(new Error("unavailable"));
      }
      let revoked = false;
      input.assertCurrent.mockImplementation(() => {
        if (revoked) {
          throw new Error("revoked");
        }
      });
      if (kind === "revoked") {
        mocks.members.mockImplementation(async () => {
          revoked = true;
          return [input.userId, "@bot:matrix.test"];
        });
      }
      await expect(isJoinedMatrixMember(input)).rejects.toThrow();
    },
  );
});
