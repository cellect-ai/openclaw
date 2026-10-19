import { MatrixError } from "matrix-js-sdk/lib/http-api/errors.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import type { MatrixClient, MatrixRawEvent } from "../sdk.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";

const roomId = "!agenda:example.org";
const text = (id: string, body: string, ts = 1000, sender = "@alex:example.org") =>
  createMatrixTextMessageEvent({ eventId: id, body, originServerTs: ts, sender });
const trigger = text("$current", "@room add him as owner rep", 5000);
trigger.content["m.mentions"] = { room: true };

function historyClient(events: MatrixRawEvent[]) {
  const doRequest = vi.fn<MatrixClient["doRequest"]>(async () => ({
    event: { ...trigger, room_id: roomId },
    events_before: events,
    events_after: [text("$later", "must not read future messages", 6000)],
  }));
  const hydrateEvents = vi.fn(
    async (_room: string, events: Array<Record<string, unknown>>) => events as MatrixRawEvent[],
  );
  return { doRequest, hydrateEvents } satisfies Partial<MatrixClient>;
}

function setup(
  client: Partial<MatrixClient>,
  options: Parameters<typeof createMatrixHandlerTestHarness>[0] = {},
) {
  return createMatrixHandlerTestHarness({
    historyLimit: 20,
    isDirectMessage: false,
    groupPolicy: "open",
    dispatchInboundMessage: async () => ({
      queuedFinal: true,
      counts: { final: 1, block: 0, tool: 0 },
    }),
    ...options,
    client,
  });
}

beforeEach(() => installMatrixMonitorTestRuntime());

describe("Matrix shared history through inbound dispatch", () => {
  it.each(["tenant-a-admin", "tenant-b-admin"])(
    "hydrates shared conversation for a fresh %s account, not another agent's session",
    async (accountId) => {
      const client = historyClient([
        text(
          "$assistant-reply",
          "The email Project Review is from Jordan Example.",
          2000,
          "@assistant:example.org",
        ),
        text("$first", "read this", 1000),
      ]);
      const freshAdmin = setup(client, { accountId });
      await freshAdmin.handler(roomId, trigger);
      expect(client.doRequest).toHaveBeenCalledWith(
        "GET",
        "/_matrix/client/v3/rooms/!agenda%3Aexample.org/context/%24current",
        { limit: 40 },
      );
      expect(freshAdmin.runPrepared).toHaveBeenCalledOnce();
      expect(freshAdmin.runPrepared.mock.calls[0]![0].ctxPayload.InboundHistory).toEqual([
        expect.objectContaining({
          messageId: "$first",
          body: "read this",
          sender: "@alex:example.org",
        }),
        expect.objectContaining({
          messageId: "$assistant-reply",
          body: "The email Project Review is from Jordan Example.",
        }),
      ]);
      expect(freshAdmin.runPrepared.mock.calls[0]![0].ctxPayload.BodyForAgent).toContain(
        "add him as owner rep",
      );
    },
  );

  it("keeps prior timeline order and omits sibling threads, redactions, ciphertext, duplicates, wrong rooms and future events", async () => {
    const threadTrigger = structuredClone(trigger);
    threadTrigger.content["m.relates_to"] = { rel_type: "m.thread", event_id: "$root" };
    const threadMessage = text("$reply", "prior shared reply", 5000, "@assistant:example.org");
    threadMessage.content["m.relates_to"] = { rel_type: "m.thread", event_id: "$root" };
    const sibling = structuredClone(threadMessage);
    sibling.event_id = "$sibling";
    sibling.content["m.relates_to"] = { rel_type: "m.thread", event_id: "$other-root" };
    const redacted = {
      ...threadMessage,
      event_id: "$redacted",
      unsigned: { redacted_because: {} },
    };
    const client = historyClient([
      { ...threadMessage, event_id: "$future", origin_server_ts: 5001 },
      { ...threadMessage, event_id: "$wrong-room", room_id: "!other-tenant:example.org" },
      { ...threadMessage, event_id: "$ciphertext", type: "m.room.encrypted" },
      redacted,
      sibling,
      text("$main", "unrelated main-room message"),
      threadMessage,
      threadMessage,
      trigger,
    ]);
    const fresh = setup(client);
    await fresh.handler(roomId, threadTrigger);
    expect(fresh.runPrepared.mock.calls[0]![0].ctxPayload.InboundHistory).toEqual([
      expect.objectContaining({ messageId: "$reply", body: "prior shared reply" }),
    ]);
  });

  it("applies supplemental sender visibility and uses the SDK hydration result", async () => {
    const client = historyClient([
      text("$denied", "not allowed", 2000, "@outsider:example.org"),
      { ...text("$encrypted", "ciphertext"), type: "m.room.encrypted" },
    ]);
    client.hydrateEvents.mockResolvedValueOnce([
      text("$denied", "not allowed", 2000, "@outsider:example.org"),
      text("$encrypted", "decrypted shared context"),
    ]);
    const fresh = setup(client, {
      roomsConfig: { [roomId]: { users: ["@alex:example.org"], requireMention: false } },
      cfg: { channels: { matrix: { contextVisibility: "allowlist" } } },
    });
    await fresh.handler(roomId, trigger);
    expect(client.hydrateEvents).toHaveBeenCalledOnce();
    expect(fresh.runPrepared.mock.calls[0]![0].ctxPayload.InboundHistory).toEqual([
      expect.objectContaining({ body: "decrypted shared context" }),
    ]);
  });

  it.each([
    { description: "explicit zero", options: { historyLimit: 0 } },
    { description: "DM", options: { isDirectMessage: true } },
    { description: "disabled room", options: { groupPolicy: "disabled" as const } },
    {
      description: "denied sender",
      options: { roomsConfig: { [roomId]: { users: ["@someone-else:example.org"] } } },
    },
  ])("does not request shared history for $description", async ({ options }) => {
    const client = historyClient([text("$private", "private")]);
    await setup(client, options).handler(roomId, trigger);
    expect(client.doRequest).not.toHaveBeenCalled();
    expect(client.hydrateEvents).not.toHaveBeenCalled();
  });

  it("does not resurrect pending context after a successful redacted window", async () => {
    const client = historyClient([]);
    const fresh = setup(client);
    await fresh.handler(roomId, text("$pending", "previously admitted but since deleted"));
    await fresh.handler(roomId, trigger);
    expect(fresh.runPrepared.mock.calls[0]![0].ctxPayload.InboundHistory).toBeUndefined();
  });

  it("caps both the requested page and hydration even for a large configured history limit", async () => {
    const client = historyClient(
      Array.from({ length: 201 }, (_, i) => text(`$history-${i}`, `message ${i}`, 4000 - i)),
    );
    const fresh = setup(client, { historyLimit: 1000 });
    await fresh.handler(roomId, trigger);
    expect(client.doRequest.mock.calls[0]![2]).toEqual({ limit: 100 });
    expect(client.hydrateEvents.mock.calls[0]![1]).toHaveLength(100);
    expect(fresh.runPrepared.mock.calls[0]![0].ctxPayload.InboundHistory).toHaveLength(100);
  });

  it.each([401, 403, 404])(
    "does not reuse cached context on denied history (%s)",
    async (statusCode) => {
      const client = historyClient([]);
      client.doRequest.mockRejectedValue(
        Object.assign(new Error("history denied"), { statusCode }),
      );
      const fresh = setup(client);
      await fresh.handler(roomId, text("$pending", "previously admitted context"));
      await fresh.handler(roomId, trigger);
      expect(client.doRequest).toHaveBeenCalledOnce();
      expect(fresh.runPrepared.mock.calls[0]![0].ctxPayload.InboundHistory).toBeUndefined();
    },
  );

  it.each(["M_FORBIDDEN", "M_NOT_FOUND", "M_UNKNOWN_TOKEN"])(
    "does not reuse cached context after SDK hydration rejects with %s",
    async (errcode) => {
      const client = historyClient([text("$encrypted", "ciphertext")]);
      client.hydrateEvents.mockRejectedValue(new MatrixError({ errcode, error: "denied" }));
      const fresh = setup(client);
      await fresh.handler(roomId, text("$pending", "previously admitted context"));
      await fresh.handler(roomId, trigger);
      expect(fresh.runPrepared.mock.calls[0]![0].ctxPayload.InboundHistory).toBeUndefined();
    },
  );

  it.each([
    null,
    { event: { ...trigger, event_id: "$wrong-anchor" }, events_before: [] },
    { event: { ...trigger, room_id: "!other-tenant:example.org" }, events_before: [] },
    { event: trigger, events_before: null },
  ])("does not reuse pending history after invalid anchored evidence %j", async (page) => {
    const client = historyClient([]);
    client.doRequest.mockResolvedValue(page);
    const fresh = setup(client);
    await fresh.handler(roomId, text("$pending", "previously admitted context"));
    await fresh.handler(roomId, trigger);
    expect(client.hydrateEvents).not.toHaveBeenCalled();
    expect(fresh.runPrepared.mock.calls[0]![0].ctxPayload.InboundHistory).toBeUndefined();
  });

  it("falls back to admitted pending context on transient failure without attempting other credentials", async () => {
    const client = historyClient([]);
    client.doRequest.mockRejectedValue(
      Object.assign(new Error("history unavailable"), { statusCode: 503 }),
    );
    const fresh = setup(client);
    await fresh.handler(roomId, text("$pending", "admitted while this account was present"));
    await fresh.handler(roomId, trigger);
    expect(client.doRequest).toHaveBeenCalledOnce();
    expect(fresh.runPrepared.mock.calls[0]![0].ctxPayload.InboundHistory).toEqual([
      expect.objectContaining({ body: "admitted while this account was present" }),
    ]);
  });

  it("does not reuse pending context when a received page cannot be hydrated", async () => {
    const client = historyClient([text("$encrypted", "ciphertext")]);
    client.hydrateEvents.mockRejectedValue(new Error("decryption failed"));
    const fresh = setup(client);
    await fresh.handler(roomId, text("$pending", "previously admitted context"));
    await fresh.handler(roomId, trigger);
    expect(fresh.runPrepared.mock.calls[0]![0].ctxPayload.InboundHistory).toBeUndefined();
  });
});
