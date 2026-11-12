import { describe, expect, it, vi } from "vitest";
import { getMatrixProjectionStatus } from "./projection-source.js";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("./thread-bindings-shared.js", () => ({
  listAllBindings: mocks.list,
  resolveBindingKey: () => "binding",
}));

describe("native projection source identity", () => {
  it.each(["slack-source", undefined])(
    "retains the source account independently of the Matrix account (%s)",
    (sourceAccountId) => {
      mocks.list.mockReturnValue([
        {
          boundAt: 1,
          boundBy: "session-projection-read-only",
          parentConversationId: "!room",
          conversationId: "$root",
          accountId: "matrix-account",
          agentId: "agent",
          targetSessionKey: "agent:agent:slack:channel:c123:thread:1.000001",
          sourceAccountId,
          environment: "test",
          projectedConversationId: "conversation",
        },
      ]);
      expect(getMatrixProjectionStatus("!room", "matrix-account")).toMatchObject({
        status: "existing",
        accountId: "matrix-account",
        sourceAccountId,
      });
    },
  );
});
