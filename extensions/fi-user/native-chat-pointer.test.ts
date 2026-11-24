import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import { publishNativeChatPointer, type NativeChatActivity } from "./native-chat-pointer.js";

const sessionKey = "agent:cellect-fi-admin:slack:channel:c123:thread:1700000000.000001";
const source = {
  provider: "slack",
  workspaceId: "T123",
  channelId: "C123",
  rootMessageId: "1700000000.000001",
};
const activity: NativeChatActivity = {
  eventId: "$native",
  originServerTs: 100,
  bindingId: "binding",
  sessionKey,
  roomId: "!room:example",
  threadRootEventId: "$root",
  accountId: "matrix",
  environment: "prod",
  conversationId: "conversation-123",
  sourceAccountId: "fi-admin",
  externalSource: source,
};
function setup() {
  const binding = {
    roomId: activity.roomId,
    sessionKey,
    sourceAccountId: "fi-admin",
    externalSource: source,
  };
  const plan = vi
    .fn()
    .mockResolvedValue({ converged: true, invariantsOk: true, nativeActivity: activity });
  const list = vi.fn().mockResolvedValue([binding]);
  const inventory = { plan, list };
  const postChatPointer = vi.fn().mockResolvedValue("posted");
  const reader = { workspaceId: "T123", postChatPointer };
  const get = vi.fn(({ channelId }: { channelId: string }) =>
    channelId === "matrix" ? inventory : reader,
  );
  const api = {
    runtime: { channel: { runtimeContexts: { get } } },
  } as unknown as OpenClawPluginApi;
  const input = {
    api,
    sessionKey,
    accountId: "fi-admin",
    channelId: "C123",
    rootMessageId: source.rootMessageId,
    chatUrl: "https://fi.example/fi/shape/chat?fiConversation=conversation-123",
  };
  return { input, plan, list, get, reader, postChatPointer, binding };
}
describe("native chat pointer authorization", () => {
  it("requires accepted Matrix-native activity, with no agent turn required", async () => {
    const s = setup();
    await publishNativeChatPointer(s.input);
    expect(s.postChatPointer).toHaveBeenCalledWith(
      expect.objectContaining({ nativeEventId: "$native", nativeEventTs: 100 }),
    );
    expect(await s.postChatPointer.mock.calls[0]![0].isCurrent()).toBe(true);
  });
  it("does nothing for a Slack-only room", async () => {
    const s = setup();
    s.plan.mockResolvedValue({ converged: true, invariantsOk: true });
    await publishNativeChatPointer(s.input);
    expect(s.postChatPointer).not.toHaveBeenCalled();
  });
  it.each(["conversationId", "sourceAccountId", "sessionKey", "roomId"] as const)(
    "rejects mismatched %s",
    async (field) => {
      const s = setup();
      s.plan.mockResolvedValue({ nativeActivity: { ...activity, [field]: "other" } });
      await publishNativeChatPointer(s.input);
      expect(s.postChatPointer).not.toHaveBeenCalled();
    },
  );
  it("rejects source workspace changes", async () => {
    const s = setup();
    s.plan.mockResolvedValue({
      nativeActivity: { ...activity, externalSource: { ...source, workspaceId: "TOTHER" } },
    });
    await publishNativeChatPointer(s.input);
    expect(s.postChatPointer).not.toHaveBeenCalled();
  });
  it("rechecks binding revocation immediately before transport writes", async () => {
    const s = setup();
    await publishNativeChatPointer(s.input);
    s.list.mockResolvedValue([]);
    expect(await s.postChatPointer.mock.calls[0]![0].isCurrent()).toBe(false);
  });
  it("rechecks runtime generation after awaited planning", async () => {
    const s = setup();
    await publishNativeChatPointer(s.input);
    s.plan.mockImplementation(async () => {
      s.get.mockReturnValue(undefined as never);
      return { nativeActivity: activity };
    });
    expect(await s.postChatPointer.mock.calls[0]![0].isCurrent()).toBe(false);
  });
  it("allows newer native activity in the same scope without a false source failure", async () => {
    const s = setup();
    await publishNativeChatPointer(s.input);
    s.plan.mockResolvedValue({
      nativeActivity: { ...activity, eventId: "$newer", originServerTs: 200 },
    });
    expect(await s.postChatPointer.mock.calls[0]![0].isCurrent()).toBe(true);
  });
  it.each([
    undefined,
    { ...activity, originServerTs: 50 },
    { ...activity, bindingId: "replacement", originServerTs: 200 },
  ])("refuses missing, older or differently bound native evidence", async (latest) => {
    const s = setup();
    await publishNativeChatPointer(s.input);
    s.plan.mockResolvedValue({ nativeActivity: latest });
    expect(await s.postChatPointer.mock.calls[0]![0].isCurrent()).toBe(false);
  });
  it("refuses aborted reconciliation", async () => {
    const s = setup();
    await publishNativeChatPointer({ ...s.input, signal: AbortSignal.abort() });
    expect(s.postChatPointer).not.toHaveBeenCalled();
  });
});
