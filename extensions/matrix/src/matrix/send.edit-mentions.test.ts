import { MatrixEvent } from "matrix-js-sdk/lib/matrix.js";
import type * as TableRuntime from "openclaw/plugin-sdk/markdown-table-runtime";
import type * as ChunkRuntime from "openclaw/plugin-sdk/reply-chunking";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../../runtime-api.js";
import { setMatrixRuntime } from "../runtime.js";

const projectionBinding = vi.hoisted(() => ({ override: undefined as unknown }));

vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/conversation-binding-runtime")>();
  return {
    ...actual,
    getSessionBindingService: () => {
      const service = actual.getSessionBindingService();
      return projectionBinding.override
        ? { ...service, resolveByConversation: () => projectionBinding.override }
        : service;
    },
  };
});

import { createBundledReplacementEvent } from "./monitor/test-events.js";
import { matrixEventToRaw } from "./sdk/event-helpers.js";
import { editMessageMatrix, sendMessageMatrix } from "./send.js";
import { makeClient, registerMatrixMediaMetadataTests } from "./send.test-support.js";
import { MATRIX_STREAM_PHASE_CONTENT_KEY } from "./send/types.js";

const loadOutboundMediaFromUrlMock = vi.hoisted(() => vi.fn());

const loadConfigMock = vi.fn(() => ({}));

const withResolvedRuntimeMatrixClientMock = vi.hoisted(() => vi.fn());

const getImageMetadataMock = vi.fn().mockResolvedValue(null);

const resizeToJpegMock = vi.fn();

const mediaKindFromMimeMock = vi.fn((_mime: string | null | undefined) => "image");

const isVoiceCompatibleAudioMock = vi.fn(
  (_options: { contentType?: string | null; fileName?: string | null }) => false,
);

const { resolveTextChunkLimitMock, resolveMarkdownTableModeMock } = vi.hoisted(() => ({
  resolveTextChunkLimitMock: vi.fn<typeof ChunkRuntime.resolveTextChunkLimit>(() => 4000),
  resolveMarkdownTableModeMock: vi.fn<typeof TableRuntime.resolveMarkdownTableMode>(() => "code"),
}));

const chunkMarkdownTextWithModeMock = vi.fn<
  (text: string, limit?: number, mode?: unknown) => string[]
>((text) => (text ? [text] : []));

vi.mock("openclaw/plugin-sdk/plugin-config-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/plugin-config-runtime")>(
    "openclaw/plugin-sdk/plugin-config-runtime",
  );
  return {
    ...actual,
    requireRuntimeConfig: vi.fn((cfg: unknown) => cfg ?? loadConfigMock()),
  };
});

vi.mock("openclaw/plugin-sdk/markdown-table-runtime", () => ({
  resolveMarkdownTableMode: resolveMarkdownTableModeMock,
}));

vi.mock("openclaw/plugin-sdk/reply-chunking", () => ({
  resolveTextChunkLimit: resolveTextChunkLimitMock,
}));

vi.mock("openclaw/plugin-sdk/outbound-media", () => ({
  loadOutboundMediaFromUrl: loadOutboundMediaFromUrlMock,
}));

vi.mock("./client-bootstrap.js", () => ({
  withResolvedRuntimeMatrixClient: withResolvedRuntimeMatrixClientMock,
}));

const runtimeStub = {
  config: {
    current: () => loadConfigMock(),
  },
  media: {
    mediaKindFromMime: (mime?: string | null) => mediaKindFromMimeMock(mime),
    isVoiceCompatibleAudio: (opts: { contentType?: string | null; fileName?: string | null }) =>
      isVoiceCompatibleAudioMock(opts),
    getImageMetadata: (...args: unknown[]) => getImageMetadataMock(...args),
    resizeToJpeg: (...args: unknown[]) => resizeToJpegMock(...args),
  },
  channel: {
    text: {
      resolveTextChunkLimit: resolveTextChunkLimitMock,
      resolveChunkMode: () => "length",
      chunkMarkdownText: (text: string) => (text ? [text] : []),
      chunkMarkdownTextWithMode: (text: string, limit: number, mode: unknown) =>
        chunkMarkdownTextWithModeMock(text, limit, mode),
      resolveMarkdownTableMode: resolveMarkdownTableModeMock,
      convertMarkdownTables: (text: string) => text,
    },
  },
} as unknown as PluginRuntime;

const requireRecord = createRequireRecord("object", "expected-label");

function createMatrixTestDecryptionFailure(event: MatrixEvent) {
  const failed = new MatrixEvent({
    ...event.event,
    type: "m.room.message",
    content: {
      msgtype: "m.bad.encrypted",
      body: "Synthetic missing session key",
      "m.relates_to": event.getWireContent()["m.relates_to"],
    },
  });
  vi.spyOn(failed, "isDecryptionFailure").mockReturnValue(true);
  return failed;
}

function sentContent(index = 0) {
  return requireRecord(sendMessage.mock.calls[index]?.[1], `sent content ${index}`);
}

function newContent(content: Record<string, unknown>) {
  return requireRecord(content["m.new_content"], "new content");
}

function resetMatrixSendRuntimeMocks() {
  setMatrixRuntime(runtimeStub);
  loadOutboundMediaFromUrlMock.mockReset().mockResolvedValue({
    buffer: Buffer.from("media"),
    fileName: "photo.png",
    contentType: "image/png",
    kind: "image",
  });
  loadConfigMock.mockReset().mockReturnValue({});
  withResolvedRuntimeMatrixClientMock
    .mockReset()
    .mockImplementation(
      async (
        opts: { client?: import("./sdk.js").MatrixClient },
        run: (resolved: import("./sdk.js").MatrixClient) => Promise<unknown>,
      ) => {
        if (!opts.client) {
          throw new Error("test Matrix client is required");
        }
        return await run(opts.client);
      },
    );
  getImageMetadataMock.mockReset().mockResolvedValue(null);
  resizeToJpegMock.mockReset();
  mediaKindFromMimeMock.mockReset().mockReturnValue("image");
  isVoiceCompatibleAudioMock.mockReset().mockReturnValue(false);
  resolveTextChunkLimitMock.mockReset().mockReturnValue(4000);
  resolveMarkdownTableModeMock.mockReset().mockReturnValue("code");
  chunkMarkdownTextWithModeMock
    .mockReset()
    .mockImplementation((text: string) => (text ? [text] : []));
}

let { client, sendMessage, sendEvent, getEvent, getRelations, uploadContent } = makeClient();

beforeEach(() => {
  vi.clearAllMocks();
  resetMatrixSendRuntimeMocks();
  ({ client, sendMessage, sendEvent, getEvent, getRelations, uploadContent } = makeClient());
});

function send(text: string, opts: Partial<Parameters<typeof sendMessageMatrix>[2]> = {}) {
  return sendMessageMatrix("room:!room:example", text, { client, cfg: {}, ...opts });
}

function edit(text: string, opts: Partial<Parameters<typeof editMessageMatrix>[3]> = {}) {
  return editMessageMatrix("room:!room:example", "$original", text, { client, cfg: {}, ...opts });
}

registerMatrixMediaMetadataTests({
  send,
  sentContent,
  loadOutboundMediaFromUrlMock,
  mediaKindFromMimeMock,
  isVoiceCompatibleAudioMock,
  get sendMessage() {
    return sendMessage;
  },
});

describe("editMessageMatrix mentions", () => {
  it("notifies only new mentions across successive edits", async () => {
    const original = createBundledReplacementEvent("$original", {
      content: { body: "Hello @alice:example.org", "m.mentions": {} },
    });
    delete original.unsigned;
    getEvent.mockImplementation(async () => ({
      ...original,
      unsigned: undefined,
    }));
    getRelations.mockImplementation(async () => ({
      events: original.unsigned?.["m.relations"]?.["m.replace"]
        ? [original.unsigned["m.relations"]["m.replace"]]
        : [],
      nextBatch: null,
    }));
    const alice = { user_ids: ["@alice:example.org"] };
    const everyone = { room: true, user_ids: ["@alice:example.org", "@bob:example.org"] };
    const revisions = [
      { text: "Hello @alice:example.org", mentions: alice, notify: alice },
      { text: "Hello again @alice:example.org", mentions: alice, notify: {} },
      {
        text: "@room Hello @alice:example.org and @bob:example.org",
        mentions: everyone,
        notify: { room: true, user_ids: ["@bob:example.org"] },
      },
      {
        text: "@room Hello again @alice:example.org and @bob:example.org",
        mentions: everyone,
        notify: {},
      },
      { text: "Hello", mentions: {}, notify: {} },
      { text: "Hello @alice:example.org", mentions: alice, notify: alice },
    ];
    for (const [index, revision] of revisions.entries()) {
      await edit(revision.text);
      const content = sentContent(index);
      expect(content["m.mentions"], `revision ${index} notifications`).toEqual(revision.notify);
      expect(newContent(content)["m.mentions"]).toEqual(revision.mentions);
      original.unsigned = {
        "m.relations": {
          "m.replace": { ...original, unsigned: undefined, event_id: `$edit-${index}`, content },
        },
      };
    }
  });

  it("places the stream phase on both halves of an edit", async () => {
    const { client, sendMessage } = makeClient();

    await editMessageMatrix("room:!room:example", "$original", "Reading", {
      client,
      cfg: {} as never,
      live: true,
      streamPhase: "progress",
    });

    const content = requireRecord(sendMessage.mock.calls[0]?.[1], `sent content 0`);
    expect(content[MATRIX_STREAM_PHASE_CONTENT_KEY]).toBe("progress");
    expect(newContent(content)[MATRIX_STREAM_PHASE_CONTENT_KEY]).toBe("progress");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetMatrixSendRuntimeMocks();
  });

  it("selects the latest valid edit across pages by timestamp and event ID", async () => {
    const original = createBundledReplacementEvent("$original");
    delete original.unsigned;
    getEvent.mockResolvedValue(original);
    const replacement = (eventId: string, timestamp: number, userIds: string[]) => ({
      ...original,
      event_id: eventId,
      origin_server_ts: timestamp,
      content: {
        "m.new_content": { body: "edited", "m.mentions": { user_ids: userIds } },
        "m.relates_to": { rel_type: "m.replace", event_id: original.event_id },
      },
    });
    const unreadable = (
      eventId: string,
      timestamp: number,
      relation = { rel_type: "m.replace", event_id: original.event_id },
    ) =>
      matrixEventToRaw(
        createMatrixTestDecryptionFailure(
          new MatrixEvent({
            sender: original.sender,
            event_id: eventId,
            origin_server_ts: timestamp,
            type: "m.room.encrypted",
            content: { "m.relates_to": relation },
          }),
        ),
      );
    getRelations
      .mockResolvedValueOnce({
        events: [replacement("$a", 300, ["@bob:example.org"])],
        nextBatch: "second",
      })
      .mockResolvedValueOnce({ events: [], nextBatch: "third" })
      .mockResolvedValueOnce({
        events: [
          unreadable("$older", 200),
          unreadable("$wrong-target", 500, { rel_type: "m.replace", event_id: "$other" }),
          unreadable("$wrong-relation", 500, { rel_type: "m.thread", event_id: "$original" }),
          {
            ...replacement("$redacted", 500, ["@bob:example.org"]),
            unsigned: { redacted_because: {} },
          },
          { ...replacement("$other", 500, ["@bob:example.org"]), sender: "@other:example.org" },
          { ...replacement("$wrong-type", 500, ["@bob:example.org"]), type: "m.room.notice" },
          replacement("$z", 300, ["@alice:example.org"]),
        ],
        nextBatch: null,
      });
    await edit("Hi @alice:example.org and @bob:example.org");
    expect(sentContent()["m.mentions"]).toEqual({ user_ids: ["@bob:example.org"] });
    expect(getRelations).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])("rejects the latest unreadable edit (pending=%s)", async (pending) => {
    const original = createBundledReplacementEvent("$original");
    delete original.unsigned;
    getEvent.mockResolvedValue(original);
    let encrypted = new MatrixEvent({
      event_id: "$unreadable",
      sender: original.sender,
      origin_server_ts: 300,
      type: "m.room.encrypted",
      content: { "m.relates_to": { rel_type: "m.replace", event_id: original.event_id } },
    });
    if (!pending) {
      encrypted = createMatrixTestDecryptionFailure(encrypted);
    }
    getRelations.mockResolvedValue({ events: [matrixEventToRaw(encrypted)], nextBatch: null });
    await expect(edit("Hello @alice:example.org")).rejects.toThrow("not fully decrypted");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each(["failed", "pending"])("does not mutate a %s original", async (mode) => {
    const original = createBundledReplacementEvent("$original");
    delete original.unsigned;
    let encrypted = new MatrixEvent({
      event_id: original.event_id,
      sender: original.sender,
      origin_server_ts: original.origin_server_ts,
      content: original.content,
      type: "m.room.encrypted",
    });
    if (mode === "failed") {
      encrypted = createMatrixTestDecryptionFailure(encrypted);
    }
    getEvent.mockResolvedValue(matrixEventToRaw(encrypted));
    await expect(edit("Hello")).rejects.toThrow("not fully decrypted");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("ignores wire decryptionFailure claims on original and bundled edits", async () => {
    const content = { body: "Hello Alice", "m.mentions": { user_ids: ["@alice:example.org"] } };
    const original = createBundledReplacementEvent("$original", {
      replacementContent: { "m.new_content": content },
    });
    requireRecord(
      original.unsigned?.["m.relations"]?.["m.replace"],
      "replacement",
    ).decryptionFailure = true;
    getEvent.mockResolvedValue({ ...original, decryptionFailure: true });
    await edit("Hello @alice:example.org");
    expect(sentContent()["m.mentions"]).toEqual({});
  });

  it("recovers legacy mentions from the original after a native overlay retires", async () => {
    const original = new MatrixEvent({
      event_id: "$original",
      sender: "@bot:example.org",
      type: "m.room.message",
      origin_server_ts: 1,
      content: { body: "Hello @alice:example.org" },
    });
    const overlay = createMatrixTestDecryptionFailure(
      new MatrixEvent({
        event_id: "$overlay",
        sender: "@bot:example.org",
        type: "m.room.encrypted",
        origin_server_ts: 2,
        content: { "m.relates_to": { rel_type: "m.replace", event_id: "$original" } },
      }),
    );
    original.makeReplaced(overlay);
    expect(original.isDecryptionFailure()).toBe(false);
    expect(original.getContent()).toEqual({});
    getEvent.mockResolvedValue(matrixEventToRaw(original));
    await edit("Hello @alice:example.org");
    expect(sentContent()["m.mentions"]).toEqual({});
  });

  it.each(["repeated", "unbounded"])(
    "does not send when relation pagination is %s",
    async (mode) => {
      const original = createBundledReplacementEvent("$original");
      delete original.unsigned;
      getEvent.mockResolvedValue(original);
      let page = 0;
      getRelations.mockImplementation(async () => ({
        events: [],
        nextBatch: mode === "repeated" ? "same" : String(++page),
      }));
      await expect(edit("Hi @alice:example.org")).rejects.toThrow(
        "history could not be fully read",
      );
      expect(sendMessage).not.toHaveBeenCalled();
      expect(getRelations.mock.calls.length).toBeLessThanOrEqual(100);
    },
  );

  it("does not suppress mentions using a redacted original", async () => {
    getEvent.mockResolvedValue(
      createBundledReplacementEvent("$original", {
        redacted: true,
        content: {},
        replacementContent: {
          "m.new_content": {
            body: "Hi @bob:example.org",
            "m.mentions": { user_ids: ["@bob:example.org"] },
          },
        },
      }),
    );
    await edit("Hello @bob:example.org");
    expect(sentContent()["m.mentions"]).toEqual({ user_ids: ["@bob:example.org"] });
  });

  it("supports quiet draft preview edits that mention nobody and skip history reads", async () => {
    getEvent.mockRejectedValue(new Error("Matrix history unavailable"));

    await edit("@room hi @alice:example.org", { msgtype: "m.notice", includeMentions: false });

    expect(getEvent).not.toHaveBeenCalled();
    const content = sentContent();
    expect(content.msgtype).toBe("m.notice");
    expect(newContent(content).msgtype).toBe("m.notice");
    expect(content["m.mentions"]).toEqual({});
    expect(newContent(content)["m.mentions"]).toEqual({});
    expect(sentContent().formatted_body).not.toContain("matrix.to");
    expect(newContent(content).formatted_body).not.toContain("matrix.to");
  });

  it("rejects thread edits when the original event is not already in that thread", async () => {
    getEvent.mockResolvedValue({
      content: {
        body: "before",
        msgtype: "m.text",
      },
    });

    await expect(edit("done", { threadId: "$thread" })).rejects.toThrow(
      "cannot add or change the original event thread relation",
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
