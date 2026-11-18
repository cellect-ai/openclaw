import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBoundSourceReplyDelivery } from "./bound-source-reply.js";

const sendMessageSlack = vi.hoisted(() => vi.fn());
vi.mock("./send.js", () => ({ sendMessageSlack }));

describe("bound source reply delivery", () => {
  beforeEach(() => {
    sendMessageSlack.mockReset().mockResolvedValue({ messageId: "1700000000.000010" });
  });

  it("posts the answer in the Slack thread and marks it so the room mirror skips it", async () => {
    const delivery = createBoundSourceReplyDelivery({
      cfg: {} as never,
      accountId: "fi-admin",
    });
    await delivery.deliver({
      channelId: "C0ACL2XFRK9",
      threadTs: "1795024539.012959",
      text: "The wire details are on file.",
      idempotencyKey: "bound-source-reply:room:event:0",
    });
    await delivery.deliver({
      channelId: "C0ACL2XFRK9",
      threadTs: "1795024539.012959",
      text: "The wire details are on file.",
      idempotencyKey: "bound-source-reply:room:event:0",
    });
    expect(sendMessageSlack).toHaveBeenCalledTimes(1);
    expect(sendMessageSlack).toHaveBeenCalledWith(
      "C0ACL2XFRK9",
      "The wire details are on file.",
      expect.objectContaining({
        accountId: "fi-admin",
        threadTs: "1795024539.012959",
        metadata: expect.objectContaining({ event_type: "cellect_bound_source_reply" }),
      }),
    );
  });
});
