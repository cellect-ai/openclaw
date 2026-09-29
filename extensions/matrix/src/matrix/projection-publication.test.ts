import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveMatrixReplyPublication,
  matrixPublicationContent,
  noteMatrixPublicationAccepted,
  createMatrixSourcePublication,
} from "./projection-publication.js";
const mocks = vi.hoisted(() => ({
  host: vi.fn(),
  owner: vi.fn(),
  note: vi.fn(),
  binding: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/reply-runtime", () => ({ resolveReplyPublication: mocks.host }));
vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", () => ({
  getSessionBindingService: () => ({ resolveByConversation: mocks.binding }),
}));
vi.mock("./projection-lifecycle.js", () => ({
  resolveMatrixProjectionRun: mocks.owner,
  noteMatrixProjectionFinalResult: mocks.note,
}));
const binding = {
  environment: "test",
  conversationId: "conversation",
  roomId: "!room",
  bindingId: "binding",
  accountId: "matrix",
  threadRootEventId: "$root",
  agentId: "agent",
};
describe("Matrix publication capabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.host.mockReturnValue({
      publicationId: "publication",
      publishedAtMs: 1000,
      kind: "final",
      channel: "matrix",
      sessionKey: "session",
      runId: "run",
    });
    mocks.owner.mockReturnValue({ generation: "opaque-owner-uuid", bindings: [binding] });
  });
  it("uses exact frozen admitted identity and complete wire topology", () => {
    const cap = resolveMatrixReplyPublication({}, "matrix", "!room", "$root")!;
    expect(Object.isFrozen(cap)).toBe(true);
    expect(matrixPublicationContent(cap, "!room", 0, 2)).toMatchObject({
      bindingId: "binding",
      generation: "opaque-owner-uuid",
      partIndex: 0,
      partCount: 2,
      complete: false,
    });
    expect(matrixPublicationContent(cap, "!room", 1, 2)).toMatchObject({
      complete: true,
      origin: { messageId: "publication", publishedAtMs: 1000 },
    });
    expect(matrixPublicationContent(cap, "!room", 1, 2)).not.toHaveProperty("finalResult");
  });
  it("rejects forged copied metadata, foreign room and invalid part topology", () => {
    const cap = resolveMatrixReplyPublication({})!;
    expect(() => matrixPublicationContent({ ...cap }, "!room", 0, 1)).toThrow("untrusted");
    expect(() => matrixPublicationContent(cap, "!foreign", 0, 1)).toThrow();
    expect(() => matrixPublicationContent(cap, "!room", 256, 257)).toThrow();
    mocks.host.mockReturnValue(undefined);
    expect(resolveMatrixReplyPublication({ runId: "run", generation: "claimed" })).toBeUndefined();
  });
  it("fails closed missing owner, ambiguous target and nonfinal status", () => {
    mocks.owner.mockReturnValue(undefined);
    expect(resolveMatrixReplyPublication({})).toBeUndefined();
    mocks.owner.mockReturnValue({
      generation: "owner",
      bindings: [binding, { ...binding, bindingId: "other" }],
    });
    expect(resolveMatrixReplyPublication({})).toBeUndefined();
    mocks.host.mockReturnValue({
      kind: "status",
      runId: "run",
      sessionKey: "session",
      channel: "matrix",
    });
    expect(resolveMatrixReplyPublication({})).toBeUndefined();
  });
  it("notes only an accepted final event for the paired owning tuple", () => {
    const cap = resolveMatrixReplyPublication({})!;
    noteMatrixPublicationAccepted({ ...cap }, "!room", "$forged");
    noteMatrixPublicationAccepted(cap, "!wrong", "$event");
    expect(mocks.note).not.toHaveBeenCalled();
    noteMatrixPublicationAccepted(cap, "!room", "$accepted");
    expect(mocks.note).toHaveBeenCalledWith({
      runId: "run",
      generation: "opaque-owner-uuid",
      bindingId: "binding",
      resultEventId: "$accepted",
    });
    const hostResult = mocks.host.mock.results[0];
    if (!hostResult || hostResult.type !== "return")
      throw new Error("Expected admitted host publication");
    mocks.host.mockReturnValue({ ...hostResult.value, kind: "block" });
    const block = resolveMatrixReplyPublication({})!;
    noteMatrixPublicationAccepted(block, "!room", "$block");
    expect(mocks.note).toHaveBeenCalledTimes(1);
  });
  it("source provenance derives reviewed persisted binding, not caller env/account claims", () => {
    const params = {
      bindingId: "binding",
      roomId: "!room",
      threadId: "$root",
      provider: "slack",
      accountId: "matrix",
      messageId: "1.000001",
      actorId: "U1",
      publishedAtMs: 1000,
      role: "user" as const,
    };
    mocks.binding.mockReturnValue({
      bindingId: "foreign",
      metadata: { environment: "test", projectedConversationId: "conversation" },
    });
    expect(createMatrixSourcePublication(params)).toBeUndefined();
    mocks.binding.mockReturnValue({
      bindingId: "binding",
      metadata: {
        environment: "test",
        projectedConversationId: "conversation",
        sourceAccountId: "actual-source",
      },
    });
    const cap = createMatrixSourcePublication(params)!;
    expect(matrixPublicationContent(cap, "!room", 0, 1)).toMatchObject({
      environment: "test",
      origin: { accountId: "actual-source", actorId: "U1" },
    });
  });
});
