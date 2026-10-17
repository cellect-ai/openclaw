import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  resolveNotificationPublicationClient,
  type NotificationPublicationScope,
} from "./notification-publication-client.js";

const scope: NotificationPublicationScope = {
  environment: "prod",
  publication_id: "db94db07-2d0b-4ba4-96a1-bbdc954d9c6d",
  room_id: "!room:matrix.test",
  conversation_id: "conversation",
  binding_id: "binding",
  run_id: "run",
  generation: "generation",
  provider: "slack",
  source_account_id: "default",
  source_workspace_id: "T0123456789",
  source_conversation_id: "C0123456789",
  source_root_message_id: "1800000000.123456",
  source_actor_ids: ["U0123456789"],
  published_at_ms: 1_800_000_000_000,
};
const actor = "U0123456789";
const recipientKey = createHash("sha256")
  .update(JSON.stringify(["slack", scope.source_workspace_id, actor]))
  .digest("hex");
const env = {
  PROJECTOR_NOTIFICATION_PRODUCER_URL: "http://private-bridge.test/",
  PROJECTOR_NOTIFICATION_PRODUCER_BEARER: "synthetic-dedicated-producer-bearer",
};
const prepared = {
  publicationId: scope.publication_id,
  prepared: true,
  recipientKey,
  reservedRoute: "mobile",
  originPermit: false,
};
function setup(response: unknown = prepared) {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response));
  const client = resolveNotificationPublicationClient(env, { fetchImpl });
  if (client.status !== "ready") {
    throw new Error("test setup invalid");
  }
  return { client, fetchImpl };
}

describe("private notification publication producer client", () => {
  it("prepares an explicit empty cohort without pretending to select a recipient", async () => {
    const empty = { ...scope, source_actor_ids: [] };
    const { client, fetchImpl } = setup({
      publicationId: scope.publication_id,
      prepared: true,
      reservedRoute: "unknown",
      originPermit: false,
    });
    await expect(client.prepare(empty)).resolves.toEqual({
      publicationId: scope.publication_id,
      prepared: true,
      reservedRoute: "unknown",
      originPermit: false,
    });
    const body = fetchImpl.mock.calls[0]?.[1]?.body;
    expect(JSON.parse(String(body))).toEqual({ scope: empty });
    await expect(client.prepare(empty, actor)).rejects.toThrow("evidence unavailable");
  });

  it.each(
    [
      [actor, actor],
      ["W0123456789", actor],
      ["invalid"],
      Array.from({ length: 33 }, (_, index) => `U${String(index).padStart(8, "0")}`),
    ].map((actors) => ({ actors })),
  )("rejects a noncanonical complete cohort $actors", async ({ actors }) => {
    const { client, fetchImpl } = setup();
    await expect(client.prepare({ ...scope, source_actor_ids: actors }, actor)).rejects.toThrow(
      "evidence unavailable",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("distinguishes absent capability from partial/invalid configuration without borrowing the registry credential", () => {
    expect(resolveNotificationPublicationClient({})).toEqual({ status: "disabled" });
    expect(
      resolveNotificationPublicationClient({
        PROJECTOR_REGISTRY_URL: env.PROJECTOR_NOTIFICATION_PRODUCER_URL,
        PROJECTOR_REGISTRY_WRITER_BEARER: env.PROJECTOR_NOTIFICATION_PRODUCER_BEARER,
      }),
    ).toEqual({ status: "disabled" });
    expect(
      resolveNotificationPublicationClient({
        PROJECTOR_NOTIFICATION_PRODUCER_URL: env.PROJECTOR_NOTIFICATION_PRODUCER_URL,
      }),
    ).toEqual({ status: "invalid" });
    expect(
      resolveNotificationPublicationClient({
        ...env,
        PROJECTOR_REGISTRY_WRITER_BEARER: env.PROJECTOR_NOTIFICATION_PRODUCER_BEARER,
      }),
    ).toEqual({ status: "invalid" });
    expect(
      resolveNotificationPublicationClient({
        PROJECTOR_NOTIFICATION_PRODUCER_BEARER: env.PROJECTOR_NOTIFICATION_PRODUCER_BEARER,
      }),
    ).toEqual({ status: "invalid" });
  });
  it.each([
    "file:///bridge",
    "https://user:secret@bridge.test",
    "http://bridge.test?secret=yes",
    "http://bridge.test/#fragment",
    "http://bridge.test/?",
    "http://bridge.test/#",
  ])("rejects unsafe endpoint %s", (url) => {
    expect(
      resolveNotificationPublicationClient({ ...env, PROJECTOR_NOTIFICATION_PRODUCER_URL: url }),
    ).toEqual({ status: "invalid" });
  });
  it("sends only frozen canonical references and never infers origin permission from mobile readiness", async () => {
    const { client, fetchImpl } = setup();
    const input = {
      ...scope,
      route: "origin",
      principalId: "must-not-leak",
      devices: ["must-not-leak"],
      body: "must-not-leak",
    };
    const pending = client.prepare(input, actor);
    input.run_id = "changed-after-call";
    expect(await pending).toEqual(prepared);
    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error("expected prepare request");
    const [url, init] = call;
    expect(url).toBe("http://private-bridge.test/v2/notification-publications/prepare");
    expect(JSON.parse(String(init?.body))).toEqual({ scope, source_actor_id: actor });
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${env.PROJECTOR_NOTIFICATION_PRODUCER_BEARER}`,
        "Content-Type": "application/json",
      },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
  it("distinguishes an origin reservation from an explicit current origin permit", async () => {
    const held = setup({ ...prepared, reservedRoute: "origin" });
    expect((await held.client.prepare(scope, actor)).originPermit).toBe(false);
    const permitted = setup({ ...prepared, reservedRoute: "origin", originPermit: true });
    expect((await permitted.client.prepare(scope, actor)).originPermit).toBe(true);
  });
  it("accepts the denied/unprepared shape without claiming recipient custody", async () => {
    const response = {
      publicationId: scope.publication_id,
      prepared: false,
      reservedRoute: "unknown",
      originPermit: false,
    };
    expect(await setup(response).client.prepare(scope, actor)).toEqual(response);
  });
  it.each([
    { publicationId: "foreign" },
    { recipientKey: "foreign" },
    { recipientKey: undefined },
    { prepared: "true" },
    { originPermit: "false" },
    { reservedRoute: "device" },
    { reservedRoute: [] },
    { reservedRoute: ["origin"] },
    { originPermit: true },
    { prepared: false },
  ])("holds malformed or mismatched prepare evidence: %j", async (change) => {
    await expect(setup({ ...prepared, ...change }).client.prepare(scope, actor)).rejects.toThrow(
      "notification publication evidence unavailable",
    );
  });
  it("acknowledges only the exact accepted event and publication receipt", async () => {
    const response = {
      publicationId: scope.publication_id,
      resultEventId: "$accepted",
      accepted: true,
    };
    const { client, fetchImpl } = setup(response);
    await client.accepted(scope, "1800000001.123456", "$accepted");
    const call = fetchImpl.mock.calls[0];
    if (!call) {
      throw new Error("Expected the accepted-publication request");
    }
    expect(call[0]).toBe("http://private-bridge.test/v2/notification-publications/accepted");
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      scope,
      source_message_id: "1800000001.123456",
      result_event_id: "$accepted",
    });
    for (const change of [
      { publicationId: "foreign" },
      { resultEventId: "$foreign" },
      { accepted: false },
      { accepted: "true" },
    ]) {
      await expect(
        setup({ ...response, ...change }).client.accepted(scope, "1800000001.123456", "$accepted"),
      ).rejects.toThrow("notification publication evidence unavailable");
    }
  });
  it("refuses malformed scope, actor and accepted references before any request", async () => {
    const { client, fetchImpl } = setup();
    for (const change of [
      { publication_id: "00000000-0000-0000-0000-000000000000" },
      { source_workspace_id: "other" },
      { published_at_ms: Number.NaN },
      { run_id: "newline\n" },
    ]) {
      await expect(client.prepare({ ...scope, ...change }, actor)).rejects.toThrow();
    }
    await expect(client.prepare(scope, "@person:matrix.test")).rejects.toThrow();
    await expect(client.accepted(scope, "source", "not-an-event")).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("holds rejected, unavailable, oversized or invalid responses without exposing remote errors", async () => {
    const { client, fetchImpl } = setup();
    const responses = [
      new Response("sensitive provider response", { status: 403 }),
      new Response("not-json"),
      new Response("x".repeat(16 * 1024 + 1)),
      new Response("{}", { headers: { "content-length": "20000" } }),
      Response.json(null),
    ];
    for (const response of responses) {
      fetchImpl.mockResolvedValueOnce(response);
      await expect(client.prepare(scope, actor)).rejects.toThrow(
        /^notification publication evidence unavailable$/,
      );
    }
    fetchImpl.mockRejectedValueOnce(
      new Error(`secret=${env.PROJECTOR_NOTIFICATION_PRODUCER_BEARER}`),
    );
    await expect(client.prepare(scope, actor)).rejects.toThrow(
      /^notification publication evidence unavailable$/,
    );
  });
});
