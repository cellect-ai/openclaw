import { beforeEach, describe, expect, it, vi } from "vitest";
import { useNoticeStores } from "./admin-action-notice.test-support.js";
import {
  ADMIN_A,
  ADMIN_B,
  REQUESTER,
  harness as baseHarness,
  toolContext,
} from "./admin-action-slack.test-support.js";
import { createRequestAdminActionTool } from "./admin-action.js";
const openNoticeStore = useNoticeStores();
const harness = (...args: Parameters<typeof baseHarness>) =>
  baseHarness(args[0], args[1], openNoticeStore().store);
beforeEach(() => {
  vi.stubEnv("SLACK_APPROVAL_TEST_BROKER", "test-broker");
});
describe("Slack notices for requests nobody can approve", () => {
  const request = {
    task: "esign_change_recipient",
    project: "559-first",
    submissionId: 124,
    currentSignerEmail: "old@example.com",
    newSignerEmail: "new@example.com",
    reason: "Signer asked for a different address",
  };

  it("tells each administrator privately, without buttons, and stores nothing", async () => {
    const h = harness(null);
    const tool = createRequestAdminActionTool(h.api, toolContext());
    const result = await tool.execute("n", request);
    expect(result.details).toMatchObject({
      status: "not_executable",
      administratorsNotified: 2,
      tellRequester: expect.stringContaining("Nothing was executed"),
    });
    const sent = h.sendText.mock.calls.map(
      (call) => call[0] as unknown as { to: string; text: string },
    );
    expect(sent.map((input) => input.to)).toEqual([`user:${ADMIN_A}`, `user:${ADMIN_B}`]);
    for (const input of sent) {
      expect((input as unknown as { accountId: string }).accountId).toBe("fi-admin");
    }
    expect(sent[0]!.text).toContain(`<@${REQUESTER}>`);
    expect(sent[0]!.text).toContain("Change an e-sign recipient");
    expect(sent[0]!.text).toContain("559-first");
    expect(sent[0]!.text).toContain("Admin agent");
    expect(h.sendPayload).not.toHaveBeenCalled();
    expect([...h.durable.namespaces.get("admin-actions")!.values()]).toHaveLength(0);
  });

  it("says so when there is no administrator to tell", async () => {
    const h = harness(null, { reviewers: [] });
    const tool = createRequestAdminActionTool(h.api, toolContext());
    await expect(tool.execute("n", request)).rejects.toThrow(/No administrator can receive/);
    expect(h.sendText).not.toHaveBeenCalled();
  });
});

describe("Slack notice limits and rendering", () => {
  const request = (description: string) => ({
    task: "document_outside_grants",
    project: "559-first",
    description,
  });

  it("sends the same notice once, lets a different one through, and caps a requester at five an hour", async () => {
    const h = harness(null);
    const tool = createRequestAdminActionTool(h.api, toolContext());
    const first = await tool.execute("n1", request("Need the Q3 lender package"));
    expect(first.details).toMatchObject({ administratorsNotified: 2 });
    h.sendText.mockClear();
    const repeat = await tool.execute("n2", request("need the  Q3 lender package"));
    expect(repeat.details).toMatchObject({
      administratorsNotified: 0,
      tellRequester: expect.stringContaining("already notified"),
    });
    expect(h.sendText).not.toHaveBeenCalled();
    const different = await tool.execute("n3", request("A different document entirely"));
    expect(different.details).toMatchObject({ administratorsNotified: 2 });
    for (const n of [4, 5]) {
      const more = await tool.execute(`n${n}`, request(`Another document ${n}`));
      expect(more.details).toMatchObject({ administratorsNotified: 2 });
    }
    // Five distinct notices have gone out; the sixth is suppressed.
    const fifth = await tool.execute("n6", request("Fifth distinct document"));
    expect(fifth.details).toMatchObject({ administratorsNotified: 2 });
    h.sendText.mockClear();
    const sixth = await tool.execute("n7", request("A sixth distinct document"));
    expect(sixth.details).toMatchObject({
      administratorsNotified: 0,
      tellRequester: expect.stringContaining("Too many administrator notices"),
    });
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it("does not count or remember a notice nobody received, so a retry sends again", async () => {
    const h = harness(null);
    const tool = createRequestAdminActionTool(h.api, toolContext());
    const normal = h.sendText.getMockImplementation()!;
    h.sendText.mockRejectedValue(new Error("slack down"));
    await expect(tool.execute("n1", request("Need the lender package"))).rejects.toThrow(
      /could not be notified/,
    );
    h.sendText.mockImplementation(normal);
    const retry = await tool.execute("n2", request("Need the lender package"));
    expect(retry.details).toMatchObject({ administratorsNotified: 2 });
  });

  it("renders the requester's description in a code block, so Slack links and formats nothing", async () => {
    const h = harness(null);
    const tool = createRequestAdminActionTool(h.api, toolContext());
    await tool.execute(
      "n",
      request(
        "see https://evil.example/x and *bold* ``` <!here> ````` *bold* https://evil.example/y",
      ),
    );
    const [first] = h.sendText.mock.calls.map((call) => call[0] as unknown as { text: string });
    expect(first!.text).toContain(
      "```\nProject: 559-first What: see https://evil.example/x and *bold* ''' &lt;!here&gt; ''''' *bold* https://evil.example/y\n```",
    );
    expect(first!.text.match(/```/g)).toHaveLength(2);
  });
});
