import type { SessionBindingRecord } from "openclaw/plugin-sdk/conversation-binding-runtime";
import { describe, expect, it } from "vitest";
import { resolveProjectionNativeActivity } from "./projection-native-activity.js";
import { MATRIX_PROJECTION_CONTENT_KEY as KEY } from "./projection-publication.js";
import type { MatrixRawEvent } from "./sdk.js";
import type { ProjectionHistory } from "./session-projection-plan.js";

const source = {
  provider: "slack",
  workspaceId: "T123",
  channelId: "C123",
  rootMessageId: "1.000001",
};
const status = {
  status: "existing" as const,
  bindingId: "binding",
  roomId: "!room",
  accountId: "matrix-account",
  agentId: "agent",
  threadRootEventId: "$root",
  targetSessionKey: "agent:agent:slack:channel:c123:thread:1.000001",
  sourceReplyAuthorization: "fi-v1",
  externalSource: source,
  environment: "test",
  conversationId: "conversation",
  sourceAccountId: "slack-account",
};
const binding: SessionBindingRecord = {
  bindingId: status.bindingId,
  targetSessionKey: status.targetSessionKey,
  targetKind: "session",
  status: "active",
  boundAt: 1,
  conversation: {
    channel: "matrix",
    accountId: status.accountId,
    parentConversationId: "!room",
    conversationId: "$root",
  },
  metadata: {
    environment: "test",
    projectedConversationId: "conversation",
    sourceAccountId: "slack-account",
    externalSource: source,
  },
};
function event(patch: Partial<MatrixRawEvent> = {}): MatrixRawEvent {
  return {
    event_id: "$native",
    sender: "@human:example.org",
    type: "m.room.message",
    origin_server_ts: 100,
    content: {
      msgtype: "m.text",
      body: "private body must not escape",
      "m.relates_to": { rel_type: "m.thread", event_id: "$root" },
    },
    ...patch,
  };
}
function publication(provider = "matrix", patch: Record<string, unknown> = {}) {
  return {
    version: 2,
    bindingId: "binding",
    roomId: "!room",
    environment: "test",
    conversationId: "conversation",
    role: "assistant",
    complete: true,
    partIndex: 0,
    partCount: 1,
    publicationRevision: 1,
    logicalPartId: "publication",
    origin: { provider, messageId: "source-message", actorId: "agent" },
    ...patch,
  };
}
function resolve(events: MatrixRawEvent[], owner: SessionBindingRecord | null = binding) {
  const history: ProjectionHistory = {
    self: "@transport:example.org",
    provider: "slack",
    threadId: "$root",
    events,
    edits: [],
  };
  return resolveProjectionNativeActivity(history, status, owner);
}

describe("content-free native projection activity", () => {
  it("includes human posts without an agent turn and binds them to current source identity", () => {
    const receipt = resolve([event()]);
    expect(receipt).toEqual({
      eventId: "$native",
      originServerTs: 100,
      bindingId: "binding",
      sessionKey: status.targetSessionKey,
      roomId: "!room",
      threadRootEventId: "$root",
      accountId: "matrix-account",
      environment: "test",
      conversationId: "conversation",
      sourceAccountId: "slack-account",
      externalSource: source,
    });
    expect(JSON.stringify(receipt)).not.toContain("private body");
    expect(JSON.stringify(receipt)).not.toContain("@human");
  });
  it.each(["matrix", "webchat"])("includes a complete %s agent publication", (provider) => {
    const native = event();
    expect(
      resolve([
        event({
          sender: "@transport:example.org",
          content: { ...native.content, [KEY]: publication(provider) },
        }),
      ])?.eventId,
    ).toBe("$native");
  });
  it.each([
    { msgtype: "m.notice" },
    { [KEY]: publication("slack") },
    { [KEY]: publication("unknown") },
    { [KEY]: "malformed" },
    { [KEY]: publication("matrix", { bindingId: "another" }) },
    { [KEY]: publication("matrix", { complete: false }) },
    { [KEY]: publication("matrix", { partCount: 2 }) },
    { "com.openclaw.session_projection": { sourceChannel: "slack", messageId: "1.000001" } },
    { "com.openclaw.source_revision": { contentHash: "unknown" } },
    { "m.relates_to": { rel_type: "m.replace", event_id: "$other" } },
    { "m.relates_to": { rel_type: "m.thread", event_id: "$another-root" } },
  ])("excludes copies, notices, incomplete publications and unknown provenance %#", (content) => {
    const native = event();
    expect(resolve([event({ content: { ...native.content, ...content } })])).toBeUndefined();
  });
  it.each([
    { unsigned: { redacted_because: {} } },
    { type: "m.room.member" },
    { room_id: "!other" },
    { origin_server_ts: Number.NaN },
    { origin_server_ts: -1 },
  ])("excludes noncurrent chat events %#", (patch) => {
    expect(resolve([event(patch)])).toBeUndefined();
  });
  it.each([
    null,
    { ...binding, bindingId: "replacement" },
    { ...binding, status: "ended" as const },
    { ...binding, targetSessionKey: "another" },
    { ...binding, metadata: { ...binding.metadata, sourceAccountId: "another" } },
    {
      ...binding,
      metadata: { ...binding.metadata, externalSource: { ...source, channelId: "C999" } },
    },
  ])("does not publish an old binding's activity after source custody changes %#", (owner) => {
    expect(resolve([event()], owner)).toBeUndefined();
  });
  it("selects the latest native event independently of source-copy order", () => {
    const native = event();
    const copy = event({
      event_id: "$copy",
      origin_server_ts: 500,
      content: { ...native.content, [KEY]: publication("slack") },
    });
    expect(
      resolve([event({ event_id: "$old", origin_server_ts: 90 }), copy, native])?.eventId,
    ).toBe("$native");
  });
  it("does not mistake legacy source continuation chunks or binding notices for native chat", () => {
    const native = event();
    const marked = event({
      event_id: "$legacy",
      sender: "@transport:example.org",
      origin_server_ts: 90,
      content: {
        ...native.content,
        body: "source message chunk",
        "com.openclaw.session_projection": { sourceChannel: "slack", messageId: "1.000001" },
      },
    });
    const chunk = event({
      sender: "@transport:example.org",
      content: { ...native.content, body: "chunk" },
    });
    expect(resolve([chunk, marked])).toBeUndefined();
    expect(
      resolve([
        event({
          sender: "@transport:example.org",
          content: { ...native.content, body: "Slack conversation history synchronized." },
        }),
      ]),
    ).toBeUndefined();
  });
});
