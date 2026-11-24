// Conformance suite every source projection adapter must pass before a new
// source merges: publish, edit, delete and replay through the real reconciler
// must produce the source-registry rows the projector expects, keyed by the
// shared idempotency derivation. Run it for a new provider by adding its
// adapter and two sample messages to `adapters` below.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matrixPublicationContent, type MatrixPublication } from "./projection-publication.js";
import {
  MATRIX_SESSION_PROJECTION_CONTENT_KEY as key,
  reconcileMatrixProjectionSnapshot,
} from "./session-projection-snapshot.js";
import {
  registerSourceProjectionAdapter,
  SLACK_SOURCE_ADAPTER,
  sourceProjectionAdapter,
  type SourceProjectionAdapter,
} from "./source-projection-adapter.js";
import {
  registryActionKey,
  resetSourceRegistryStateForTest,
  type RegistryMappingBody,
} from "./source-registry.js";

const mocks = vi.hoisted(() => ({
  events: [] as any[],
  edits: [] as any[],
  binding: vi.fn(),
  send: vi.fn(),
  edit: vi.fn(),
  redact: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", () => ({
  getSessionBindingService: () => ({ resolveByConversation: mocks.binding }),
}));
vi.mock("./projection-source-result.js", () => ({
  noteMatrixSourceSnapshotResult: vi.fn(),
}));
vi.mock("./send/client.js", () => ({
  withResolvedMatrixSendClient: async (_opts: unknown, run: (client: unknown) => Promise<void>) =>
    run({
      getRelations: async (_room: string, eventId: string, rel: string) => ({
        events:
          rel === "m.replace"
            ? mocks.edits
                .filter((edit) => edit.content["m.relates_to"].event_id === eventId)
                .toReversed()
            : [...mocks.events].toReversed(),
        nextBatch: null,
        prevBatch: null,
      }),
      hydrateEvents: async (_room: string, events: unknown[]) => events,
      getUserId: async () => "@transport:example.org",
      redactEvent: mocks.redact,
    }),
}));
vi.mock("./send.js", () => ({
  sendMessageMatrix: mocks.send,
  editMessageMatrix: mocks.edit,
}));

/** A second source that exists only in this suite. */
const FAKE_MAIL_ADAPTER: SourceProjectionAdapter = {
  provider: "fakemail",
  label: "Fakemail",
  validMessageId: (messageId) => /^<[^<>\s]{1,200}>$/.test(messageId),
  publishedAtMs: () => undefined,
  conversationRef: (source) => `${source.channelId}:${source.rootMessageId}`,
};

const adapters: Array<{
  adapter: SourceProjectionAdapter;
  source: { workspaceId: string; channelId: string; rootMessageId: string };
  messageIds: [string, string];
}> = [
  {
    adapter: SLACK_SOURCE_ADAPTER,
    source: {
      workspaceId: "T1",
      channelId: "C1",
      rootMessageId: "1700000000.000001",
    },
    messageIds: ["1700000000.000001", "1700000000.000002"],
  },
  {
    adapter: FAKE_MAIL_ADAPTER,
    source: {
      workspaceId: "mailbox-1",
      channelId: "inbox",
      rootMessageId: "<root@mail.test>",
    },
    messageIds: ["<a1@mail.test>", "<a2@mail.test>"],
  },
];

describe.each(adapters)("source adapter $adapter.provider", ({ adapter, source, messageIds }) => {
  const room = "!room:example.org";
  const params = {
    cfg: {} as never,
    accountId: "account",
    roomId: room,
    threadId: "$root",
  };
  const bodies: RegistryMappingBody[] = [];
  let unregister: (() => void) | undefined;
  const message = (messageId: string, content: string) => ({
    messageId,
    senderId: "author",
    role: "user" as const,
    content,
    sourceTs: 1_700_000_000_000,
  });
  const reconcile = (...messages: ReturnType<typeof message>[]) =>
    reconcileMatrixProjectionSnapshot({
      ...params,
      snapshot: { complete: true, messages },
    });

  beforeEach(() => {
    vi.clearAllMocks();
    resetSourceRegistryStateForTest();
    bodies.length = 0;
    mocks.events.length = 0;
    mocks.edits.length = 0;
    if (!sourceProjectionAdapter(adapter.provider)) {
      unregister = registerSourceProjectionAdapter(adapter);
    }
    vi.stubEnv("MATRIX_SOURCE_REGISTRY", "write");
    vi.stubEnv("PROJECTOR_REGISTRY_URL", "http://projector.test");
    vi.stubEnv("PROJECTOR_REGISTRY_WRITER_BEARER", "w".repeat(64));
    vi.stubEnv("MATRIX_SOURCE_REGISTRY_ORG", "org-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string));
        return new Response(JSON.stringify({ replayed: false, logged: 1, drift: 0 }));
      }),
    );
    mocks.binding.mockReturnValue({
      bindingId: "binding",
      metadata: {
        environment: "test",
        projectedConversationId: "conversation",
        externalSource: { provider: adapter.provider, ...source },
      },
    });
    mocks.send.mockImplementation(
      async (
        _to: string,
        body: string,
        opts: { publication: MatrixPublication; extraContent: object },
      ) => {
        const eventId = `$event${mocks.events.length}`;
        mocks.events.push({
          event_id: eventId,
          sender: "@transport:example.org",
          type: "m.room.message",
          origin_server_ts: 1_700_000_000_500 + mocks.events.length,
          content: {
            body,
            ...opts.extraContent,
            [key]: matrixPublicationContent(opts.publication, room, 0, 1),
            "m.relates_to": { rel_type: "m.thread", event_id: "$root" },
          },
        });
        return {
          messageId: eventId,
          receipt: { platformMessageIds: [eventId] },
        };
      },
    );
    mocks.edit.mockImplementation(
      async (
        _room: string,
        target: string,
        body: string,
        opts: { publication: MatrixPublication; extraContent: object },
      ) => {
        const eventId = `$edit${mocks.edits.length}`;
        mocks.edits.push({
          event_id: eventId,
          sender: "@transport:example.org",
          type: "m.room.message",
          content: {
            body: `* ${body}`,
            "m.new_content": {
              body,
              ...opts.extraContent,
              [key]: matrixPublicationContent(opts.publication, room, 0, 1),
            },
            "m.relates_to": { rel_type: "m.replace", event_id: target },
          },
        });
        return eventId;
      },
    );
    mocks.redact.mockImplementation(async (_room: string, id: string) => {
      const event = [...mocks.events, ...mocks.edits].find(
        (candidate) => candidate.event_id === id,
      );
      event.unsigned = { redacted_because: {} };
    });
  });
  afterEach(() => {
    unregister?.();
    unregister = undefined;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("declares a well-formed provider contract", () => {
    expect(adapter.provider).toMatch(/^[a-z0-9_-]{1,32}$/);
    expect(messageIds.every((id) => adapter.validMessageId(id))).toBe(true);
    expect(adapter.validMessageId("")).toBe(false);
    const ref = adapter.conversationRef({
      provider: adapter.provider,
      ...source,
    });
    expect(ref.trim()).not.toBe("");
    expect(ref.length).toBeLessThanOrEqual(256);
  });

  it("publish, edit, delete and replay produce the registry rows the projector expects", async () => {
    const [first, second] = messageIds;
    const identity = {
      provider: adapter.provider,
      accountId: source.workspaceId,
    };

    // publish
    await reconcile(message(first, "one"), message(second, "two"));
    const published = bodies.at(-1)!;
    expect(published).toMatchObject({
      provider: adapter.provider,
      accountId: source.workspaceId,
      conversationRef: adapter.conversationRef({
        provider: adapter.provider,
        ...source,
      }),
      threadRootEventId: "$root",
      publisher: "@transport:example.org",
      orgId: "org-1",
      messages: [
        {
          messageId: first,
          revision: 1,
          parts: [{ partIndex: 0, eventId: "$event0" }],
        },
        {
          messageId: second,
          revision: 1,
          parts: [{ partIndex: 0, eventId: "$event1" }],
        },
      ],
    });
    expect(
      published.actions.map((action) => [action.kind, action.messageId, action.eventId]),
    ).toEqual([
      ["publish", first, "$event0"],
      ["publish", second, "$event1"],
    ]);

    // edit in place
    await reconcile(message(first, "one, edited"), message(second, "two"));
    const edited = bodies.at(-1)!;
    expect(edited.messages[0]).toMatchObject({
      messageId: first,
      revision: 2,
      parts: [{ partIndex: 0, eventId: "$event0", editEventId: "$edit0" }],
    });
    expect(edited.actions).toMatchObject([
      {
        kind: "edit",
        messageId: first,
        revision: 2,
        partIndex: 0,
        eventId: "$edit0",
        replacesEventId: "$event0",
      },
    ]);
    expect(registryActionKey(identity, room, edited.actions[0]!)).toContain(":edit:$event0");

    // delete in source
    await reconcile(message(second, "two"));
    const deleted = bodies.at(-1)!;
    expect(deleted.messages.map((entry) => entry.messageId)).toEqual([second]);
    expect(deleted.actions.map((action) => [action.kind, action.eventId, action.revision])).toEqual(
      [
        ["redact", "$edit0", 2],
        ["redact", "$event0", 2],
      ],
    );

    // replay: nothing changed, nothing written
    const count = bodies.length;
    await reconcile(message(second, "two"));
    expect(bodies).toHaveLength(count);

    // Every logged row has a distinct key and each PUT's generation grows.
    const keys = bodies.flatMap((body) =>
      body.actions.map((action) => registryActionKey(identity, room, action)),
    );
    expect(new Set(keys).size).toBe(keys.length);
    const generations = bodies.map((body) => body.generation);
    expect(generations).toEqual(generations.toSorted((left, right) => left - right));
    expect(new Set(generations).size).toBe(generations.length);
  });
});
