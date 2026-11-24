import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matrixPublicationContent, type MatrixPublication } from "./projection-publication.js";
import type { MatrixRawEvent } from "./sdk.js";
import {
  projectionMapping,
  SOURCE_CONTENT_REVISION_KEY,
  type ProjectionHistory,
} from "./session-projection-plan.js";
import {
  reconcileMatrixProjectionSnapshot,
  MATRIX_SESSION_PROJECTION_CONTENT_KEY as key,
} from "./session-projection-snapshot.js";
import {
  isSourceRegistryDirty,
  nextRegistryGeneration,
  redactionSlot,
  registryActionKey,
  registryMessages,
  resetSourceRegistryStateForTest,
  sourceIdempotencyKey,
  syncSourceRegistry,
  type RegistryMappingBody,
  type RegistryRoomIdentity,
} from "./source-registry.js";

// Copied verbatim from cellect-threads 758dc76
// (projector/tests/fixtures/source-idempotency.json); the Rust projector pins
// the same vector, so both sides derive identical change-log keys.
const vector = JSON.parse(
  readFileSync(new URL("./__fixtures__/source-idempotency.json", import.meta.url), "utf8"),
) as {
  cases: Array<{ fields: Record<string, string | number | null>; key: string }>;
  observed: Array<{
    event: Record<string, any>;
    mapping?: Record<string, any>;
    action: Record<string, any>;
    key: string;
  }>;
};

describe("source registry idempotency key", () => {
  it.each(vector.cases.map((entry) => [entry.key, entry] as const))(
    "reproduces %s",
    (_key, entry) => {
      const f = entry.fields;
      expect(
        sourceIdempotencyKey({
          provider: String(f.provider),
          account: String(f.account),
          message: String(f.message),
          room: String(f.room),
          revision: f.revision as number | null,
          part: f.part as number | null,
          kind: String(f.kind),
          target: String(f.target),
        }),
      ).toBe(entry.key);
    },
  );

  it.each(vector.observed.map((entry) => [entry.key, entry] as const))(
    "keys the gateway action for observed %s like the projector",
    (_key, entry) => {
      const origin =
        entry.mapping ?? entry.event.content["m.new_content"]["ai.cellect.projection"].origin;
      expect(
        registryActionKey(
          { provider: origin.provider, accountId: origin.accountId },
          entry.event.room_id,
          { ...entry.action, kind: entry.action.kind } as never,
        ),
      ).toBe(entry.key);
    },
  );

  it("keys a redaction by the copy's slot after its in-place edit, as the observer does", () => {
    const redaction = vector.observed.find((entry) => entry.action.kind === "redact")!;
    const mapped = redaction.mapping!;
    const marker = (revision: number) => ({
      [key]: {
        version: 2,
        origin: {
          provider: "slack",
          accountId: "default",
          messageId: mapped.messageId,
        },
        publicationRevision: revision,
        partIndex: 0,
        partCount: 1,
        complete: true,
      },
    });
    const self = "@cellect-fi:matrix.test";
    const history: ProjectionHistory = {
      self,
      threadId: "$root",
      events: [
        {
          event_id: "$copy-a",
          sender: self,
          type: "m.room.message",
          origin_server_ts: 1,
          content: {
            body: "a",
            ...marker(1),
            "m.relates_to": { rel_type: "m.thread", event_id: "$root" },
          },
        } as MatrixRawEvent,
      ],
      edits: [
        {
          event_id: "$edit-1",
          sender: self,
          type: "m.room.message",
          origin_server_ts: 2,
          content: {
            body: "* b",
            "m.new_content": { body: "b", ...marker(3) },
            "m.relates_to": { rel_type: "m.replace", event_id: "$copy-a" },
          },
        } as MatrixRawEvent,
      ],
    };
    const slot = redactionSlot(history, "$copy-a");
    expect(slot).toEqual({ revision: 3, partIndex: 0 });
    expect(
      registryActionKey({ provider: "slack", accountId: "default" }, "!projection:matrix.test", {
        kind: "redact",
        messageId: mapped.messageId,
        revision: slot.revision,
        partIndex: slot.partIndex,
        eventId: "$copy-a",
      }),
    ).toBe(redaction.key);
  });
});

describe("registry mapping", () => {
  it("keeps identifiers and hashes only, and drops what the projector would refuse", () => {
    expect(
      registryMessages([
        {
          messageId: "m1",
          revision: 2,
          partCount: 2,
          complete: true,
          parts: [
            { partIndex: 1, eventId: "$b", originServerTs: 5 },
            { partIndex: 0, eventId: "$a", editEventId: "$e" },
          ],
          liveEventIds: ["$a", "$b"],
          contentHash: "ab".repeat(32),
          sourceTs: 1700000000000,
        },
        {
          messageId: "m2",
          revision: 1,
          partCount: null,
          complete: false,
          parts: [],
          liveEventIds: [],
        },
        {
          messageId: "m3",
          revision: 1,
          partCount: 1,
          complete: true,
          parts: [{ partIndex: 0, eventId: "$a" }],
          liveEventIds: ["$a"],
          contentHash: "NOT HEX",
        },
      ]),
    ).toEqual([
      {
        messageId: "m1",
        revision: 2,
        contentHash: "ab".repeat(32),
        sourceTs: 1700000000000,
        parts: [
          { partIndex: 0, eventId: "$a", editEventId: "$e" },
          { partIndex: 1, eventId: "$b" },
        ],
      },
    ]);
  });

  it("issues a hybrid-clock generation that never goes below stored + 1", () => {
    expect(nextRegistryGeneration(undefined, 1000)).toBe(1000);
    expect(nextRegistryGeneration(5000, 1000)).toBe(5001);
  });
});

const identity: RegistryRoomIdentity = {
  provider: "slack",
  accountId: "T1",
  conversationRef: "C1:1700000000.000000",
  threadRootEventId: "$root",
  publisher: "@transport:example.org",
};
const config = {
  url: "http://projector.test",
  bearer: "w".repeat(64),
  orgId: "shape",
};

function historyOf(...eventIds: string[]): ProjectionHistory {
  return {
    self: identity.publisher,
    threadId: "$root",
    edits: [],
    events: eventIds
      .map((eventId, index) => ({
        event_id: eventId,
        sender: identity.publisher,
        type: "m.room.message",
        origin_server_ts: 1000 + index,
        content: {
          body: eventId,
          [SOURCE_CONTENT_REVISION_KEY]: { contentHash: "cd".repeat(32) },
          [key]: {
            version: 2,
            origin: {
              provider: "slack",
              accountId: "T1",
              messageId: `170000000${index}.000001`,
            },
            publicationRevision: 1,
            partIndex: 0,
            partCount: 1,
            complete: true,
          },
          "m.relates_to": { rel_type: "m.thread", event_id: "$root" },
        },
      }))
      .toReversed() as MatrixRawEvent[],
  };
}

function response(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status });
}

describe("syncSourceRegistry", () => {
  beforeEach(() => resetSourceRegistryStateForTest());

  it("is off without MATRIX_SOURCE_REGISTRY=write", async () => {
    const fetchImpl = vi.fn();
    const result = await syncSourceRegistry({
      roomId: "!r",
      identity,
      history: historyOf("$a"),
      config: undefined,
      fetchImpl,
    });
    expect(result).toEqual({ status: "disabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails open, marks the room dirty, and re-PUTs the pending actions next pass", async () => {
    const bodies: RegistryMappingBody[] = [];
    const persisted: number[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return bodies.length === 1
        ? response(503, { error: "unavailable" })
        : response(200, { replayed: false, logged: 1, drift: 0 });
    }) as unknown as typeof fetch;
    const applied = [
      {
        kind: "publish" as const,
        messageId: "1700000000.000001",
        revision: 1,
        partIndex: 0,
        eventId: "$a",
      },
    ];
    const base = {
      roomId: "!r:example.org",
      identity,
      config,
      fetchImpl,
      storedGeneration: 7,
      persistGeneration: (generation: number) => persisted.push(generation),
    };
    const first = await syncSourceRegistry({
      ...base,
      history: historyOf("$a"),
      applied,
    });
    expect(first).toMatchObject({
      status: "failed",
      httpStatus: 503,
      reason: "unavailable",
    });
    expect(isSourceRegistryDirty("!r:example.org")).toBe(true);

    const second = await syncSourceRegistry({
      ...base,
      history: historyOf("$a"),
    });
    expect(second).toMatchObject({
      status: "written",
      messages: 1,
      parts: 1,
      logged: 1,
    });
    expect(isSourceRegistryDirty("!r:example.org")).toBe(false);
    expect(bodies[1]).toMatchObject({
      orgId: "shape",
      provider: "slack",
      accountId: "T1",
      conversationRef: "C1:1700000000.000000",
      threadRootEventId: "$root",
      publisher: identity.publisher,
      actor: "gateway",
      archived: false,
      messages: [
        {
          messageId: "1700000000.000001",
          revision: 1,
          contentHash: "cd".repeat(32),
          parts: [{ partIndex: 0, eventId: "$a" }],
        },
      ],
      actions: applied,
    });
    expect(bodies[1]!.generation).toBeGreaterThan(bodies[0]!.generation);
    expect(bodies[0]!.generation).toBeGreaterThan(7);
    expect(persisted).toEqual(bodies.map((body) => body.generation));
    expect(vi.mocked(fetchImpl).mock.calls[0]![0] as string).toBe(
      "http://projector.test/v2/sources/rooms/!r%3Aexample.org/mapping",
    );
    expect(vi.mocked(fetchImpl).mock.calls[0]![1]).toMatchObject({
      method: "PUT",
      headers: { authorization: `Bearer ${"w".repeat(64)}` },
    });

    // Unchanged mapping, nothing pending, not dirty: no request.
    await expect(syncSourceRegistry({ ...base, history: historyOf("$a") })).resolves.toEqual({
      status: "unchanged",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // A part that appeared without a reconcile action is a live publication.
    await syncSourceRegistry({ ...base, history: historyOf("$a", "$b") });
    expect(bodies[2]!.actions).toEqual([
      {
        kind: "publish",
        messageId: "1700000001.000001",
        revision: 1,
        partIndex: 0,
        eventId: "$b",
        contentHash: "cd".repeat(32),
      },
    ]);
  });

  it("never throws: a timeout is a failed, dirty pass", async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    await expect(
      syncSourceRegistry({
        roomId: "!t",
        identity,
        history: historyOf("$a"),
        config,
        fetchImpl,
      }),
    ).resolves.toMatchObject({ status: "failed", reason: "timeout" });
    expect(isSourceRegistryDirty("!t")).toBe(true);
  });

  it("backfills one backfill row per retained part with its origin_server_ts", async () => {
    let body: RegistryMappingBody | undefined;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return response(200, { replayed: false, logged: 2, drift: 0 });
    }) as unknown as typeof fetch;
    const history = historyOf("$a", "$b");
    const result = await syncSourceRegistry({
      roomId: "!b",
      identity,
      history,
      actor: "backfill",
      applied: [{ kind: "redact", eventId: "$gone" }],
      config,
      fetchImpl,
    });
    expect(result).toMatchObject({ status: "written", messages: 2, parts: 2 });
    expect(body?.actor).toBe("backfill");
    expect(body?.actions).toEqual(
      projectionMapping(history).map((entry, index) => ({
        kind: "backfill",
        messageId: entry.messageId,
        revision: 1,
        partIndex: 0,
        eventId: entry.parts[0]!.eventId,
        contentHash: "cd".repeat(32),
        originServerTs: 1000 + index,
      })),
    );
  });
});

// Reconcile integration: the registry never changes a reconcile's outcome.
const mocks = vi.hoisted(() => ({
  events: [] as any[],
  send: vi.fn(),
  redact: vi.fn(),
  binding: vi.fn(),
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
      getRelations: async (_room: string, _event: string, rel: string) => ({
        events: rel === "m.replace" ? [] : [...mocks.events].toReversed(),
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
  editMessageMatrix: vi.fn(),
}));

describe("reconcile with the source registry", () => {
  const snapshot = {
    complete: true,
    messages: [
      {
        messageId: "1700000000.000001",
        senderId: "U1",
        role: "user",
        content: "Hi",
      },
    ],
  };
  const params = {
    cfg: {} as never,
    accountId: "account",
    roomId: "!room",
    threadId: "$root",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetSourceRegistryStateForTest();
    mocks.events.length = 0;
    vi.stubEnv("MATRIX_SOURCE_REGISTRY", "write");
    vi.stubEnv("PROJECTOR_REGISTRY_URL", "http://projector.test/");
    vi.stubEnv("PROJECTOR_REGISTRY_WRITER_BEARER", "w".repeat(64));
    vi.stubEnv("MATRIX_SOURCE_REGISTRY_ORG", "shape");
    mocks.binding.mockReturnValue({
      bindingId: "binding",
      metadata: {
        environment: "prod",
        projectedConversationId: "conversation",
        externalSource: {
          provider: "slack",
          workspaceId: "T1",
          channelId: "C1",
          rootMessageId: "1700000000.000001",
        },
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
          origin_server_ts: 1,
          content: {
            body,
            ...opts.extraContent,
            [key]: matrixPublicationContent(opts.publication, "!room", 0, 1),
            "m.relates_to": { rel_type: "m.thread", event_id: "$root" },
          },
        });
        return {
          messageId: eventId,
          receipt: { platformMessageIds: [eventId] },
        };
      },
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("converges while the registry is down, then re-PUTs on the next pass", async () => {
    const bodies: RegistryMappingBody[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return bodies.length === 1
        ? response(503, { error: "unavailable" })
        : response(200, { replayed: false, logged: 1, drift: 0 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      reconcileMatrixProjectionSnapshot({ ...params, snapshot }),
    ).resolves.toBeUndefined();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.events).toHaveLength(1);
    expect(isSourceRegistryDirty("!room")).toBe(true);

    // Converged pass: no Matrix writes, but the dirty room is PUT again with
    // the publication the failed PUT could not deliver.
    await reconcileMatrixProjectionSnapshot({ ...params, snapshot });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({
      provider: "slack",
      accountId: "T1",
      conversationRef: "C1:1700000000.000001",
      threadRootEventId: "$root",
      messages: [
        {
          messageId: "1700000000.000001",
          parts: [{ partIndex: 0, eventId: "$event0" }],
        },
      ],
      actions: [
        {
          kind: "publish",
          messageId: "1700000000.000001",
          revision: 1,
          partIndex: 0,
          eventId: "$event0",
        },
      ],
    });
    expect(isSourceRegistryDirty("!room")).toBe(false);

    await reconcileMatrixProjectionSnapshot({ ...params, snapshot });
    expect(bodies).toHaveLength(2);
  });

  it("makes no registry request while the flag is off", async () => {
    vi.stubEnv("MATRIX_SOURCE_REGISTRY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await reconcileMatrixProjectionSnapshot({ ...params, snapshot });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs a source deletion as a redact keyed by the copy's slot", async () => {
    const bodies: RegistryMappingBody[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string));
        return response(200, { replayed: false, logged: 1, drift: 0 });
      }),
    );
    mocks.redact.mockImplementation(async (_room: string, id: string) => {
      const event = mocks.events.find((candidate) => candidate.event_id === id);
      event.unsigned = { redacted_because: {} };
    });
    await reconcileMatrixProjectionSnapshot({ ...params, snapshot });
    await reconcileMatrixProjectionSnapshot({
      ...params,
      snapshot: { complete: true, messages: [] },
    });
    expect(bodies[1]).toMatchObject({
      messages: [],
      actions: [
        {
          kind: "redact",
          messageId: "1700000000.000001",
          revision: 1,
          partIndex: 0,
          eventId: "$event0",
        },
      ],
    });
  });
});
