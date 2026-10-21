import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerAdminActionRpc } from "./admin-action-rpc.js";
import {
  adminHandoffBlock,
  createRequestAdminActionTool,
  type AdminActionRecord,
} from "./admin-action.js";
import { approvalStores } from "./admin-action.test-support.js";

const origin = {
  orgId: "org-test",
  roomId: "!room:example.test",
  threadRootEventId: "$root",
  agentMxid: "@bot:example.test",
};
const target = {
  tenantOrgId: origin.orgId,
  requestId: "ABC234",
  revision: 1,
  ...origin,
  requesterMatrixUserId: "@admin:example.test",
};
const record = (): AdminActionRecord => ({
  id: "ABC234",
  task: "external_share_link",
  fields: {},
  origin,
  revision: 1,
  createdAt: Date.now(),
  status: "pending",
  publicationEventId: "$card",
  requester: {
    email: "admin@example.test",
    identity: { channel: "matrix", requesterMatrixUserId: target.requesterMatrixUserId },
  },
  delivery: {
    channel: "matrix",
    to: origin.roomId,
    threadId: origin.threadRootEventId,
    accountId: "fi-user",
  },
});

function harness(value = record()) {
  const durable = approvalStores({ ABC234: value });
  const cfg = {
    channels: { matrix: { accounts: { "fi-user": { userId: origin.agentMxid } } } },
    plugins: {
      entries: {
        "fi-user": {
          config: {
            tenantOrgId: origin.orgId,
            baseUrl: "https://fi.example.test",
            brokerTokenEnv: "APPROVAL_TEST_BROKER",
          },
        },
      },
    },
  };
  const handlers = new Map<string, (options: GatewayRequestHandlerOptions) => unknown>();
  const scopes = new Map<string, unknown>();
  const sendPayload = vi.fn(async () => ({ messageId: "$edit" }));
  const subagentRun = vi.fn();
  let current = true;
  const api = {
    config: cfg,
    logger: { warn: vi.fn() },
    runtime: {
      config: { current: () => cfg },
      state: { openKeyedStore: durable.openKeyedStore },
      channel: { outbound: { loadAdapter: async () => ({ sendPayload }) } },
      subagent: { run: subagentRun },
    },
    registerGatewayMethod: (
      name: string,
      handler: (options: GatewayRequestHandlerOptions) => unknown,
      opts: unknown,
    ) => {
      handlers.set(name, handler);
      scopes.set(name, opts);
    },
  } as unknown as OpenClawPluginApi;
  registerAdminActionRpc(api);
  async function invoke(
    method: "describe" | "decide",
    params: Record<string, unknown>,
    device = "real-fi-device",
  ) {
    const respond = vi.fn();
    await handlers.get(`fi.adminAction.${method}`)!({
      params,
      respond,
      client: { connect: { device: { id: device } } },
      hasCurrentClientAuthority: () => current,
    } as unknown as GatewayRequestHandlerOptions);
    return respond.mock.calls[0]!;
  }
  return {
    ...durable,
    api,
    invoke,
    scopes,
    sendPayload,
    subagentRun,
    revoke: () => {
      current = false;
    },
  };
}

beforeEach(() => {
  vi.stubEnv("APPROVAL_TEST_BROKER", "test-broker");
  vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ "fi-user": "prod" }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      const input = JSON.parse(String(init.body));
      return Response.json({
        ok: input.gatewayDeviceId === "real-fi-device",
        orgId: origin.orgId,
        matrixUserId: target.requesterMatrixUserId,
        role: "admin",
      });
    }),
  );
});

describe("registered native business approval boundary", () => {
  it("does not offer an actionable card to a member lacking authoritative preparation", async () => {
    const h = harness();
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        user: {
          email: "member@example.test",
          orgSlug: "test",
          orgId: origin.orgId,
          role: "member",
        },
        fi: { token: "member-token", expiresAt: 1_900_000_000 },
        gmail: { enabled: false, mailbox: null },
      }),
    );
    const tool = createRequestAdminActionTool(h.api, {
      agentId: "cellect-fi-user",
      messageChannel: "matrix",
      agentAccountId: "fi-user",
      requesterSenderId: "@member:example.test",
      nativeChannelId: origin.roomId,
      deliveryContext: {
        channel: "matrix",
        to: origin.roomId,
        accountId: "fi-user",
        threadId: origin.threadRootEventId,
      },
    });
    expect(
      await tool.execute("request", {
        task: "restricted_filing",
        project: "project",
        roomId: "room-one",
        description: "File document",
      }),
    ).toMatchObject({ details: { status: "not_executable", cardPosted: false } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(h.sendPayload).not.toHaveBeenCalled();
  });
  it("publishes a prepared PFS/REO card with named KYC and completion targets in the originating thread", async () => {
    const h = harness();
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        user: {
          email: "requester@example.test",
          orgSlug: "test",
          orgId: origin.orgId,
          role: "admin",
        },
        fi: { token: "requester-token", expiresAt: 1_900_000_000 },
        gmail: { enabled: false, mailbox: null },
      }),
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        user: {
          email: "requester@example.test",
          orgSlug: "test",
          orgId: origin.orgId,
          role: "admin",
        },
        fi: { token: "admin-token", expiresAt: 1_900_000_000 },
        gmail: { enabled: false, mailbox: null },
      }),
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        ok: true,
        result: {
          applied: false,
          operation: "file",
          actor: "requester@example.test",
          room: "room-one",
          expectedRoomVersion: 3,
          placement: {
            documentId: "doc-one",
            displayName: "Lorenzo Personal Financial Statement and REO Schedule",
            roomCategory: "KYC",
            orderKey: "2.01",
            visibility: "shared",
            isHighlighted: false,
            tags: [],
          },
          taskIds: ["kyc", "pfs"],
          completeTaskIds: ["pfs"],
          preparedTarget: {
            room: { id: "room-one", name: "82 Sussex — Q3 2026 lender diligence" },
            document: {
              id: "doc-one",
              filename: "Lorenzo_PFS_REO_2026-10.pdf",
              sha256: "a".repeat(64),
              sourceUpdatedAt: "2026-10-21T00:00:00.000Z",
            },
            tasks: [
              { id: "kyc", title: "KYC — Sponsor identity documents", complete: false },
              {
                id: "pfs",
                title: "PFS — Personal financial statement and REO schedule",
                complete: true,
              },
            ],
          },
        },
      }),
    );
    const tool = createRequestAdminActionTool(h.api, {
      agentId: "cellect-fi-user",
      messageChannel: "matrix",
      agentAccountId: "fi-user",
      requesterSenderId: "@requester:example.test",
      nativeChannelId: origin.roomId,
      sessionKey: "agent:cellect-fi-user:matrix:room:test:thread:root",
      deliveryContext: {
        channel: "matrix",
        to: origin.roomId,
        threadId: origin.threadRootEventId,
        accountId: "fi-user",
      },
      assertInvocationCurrent: () => {},
    });
    const result = await tool.execute("call", {
      task: "restricted_filing",
      project: "project-one",
      documentId: "doc-one",
      roomId: "room-one",
      displayName: "Lorenzo Personal Financial Statement and REO Schedule",
      section: "KYC",
      order: "2.1",
      visibility: "shared",
      taskIds: ["kyc", "pfs"],
      completeTaskIds: ["pfs"],
      description: "File the selected signed agreement",
    });
    const id = (result.details as { requestId: string }).requestId;
    const stored = h.namespaces.get("admin-actions")!.get(id) as AdminActionRecord;
    expect(stored).toMatchObject({
      origin,
      publicationEventId: "$edit",
      revision: 1,
      status: "pending",
      preparedFiling: {
        expectedRoomVersion: 3,
        documentFilename: "Lorenzo_PFS_REO_2026-10.pdf",
        roomName: "82 Sussex — Q3 2026 lender diligence",
        input: { order: "2.01" },
      },
    });
    expect(h.sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        to: origin.roomId,
        threadId: origin.threadRootEventId,
        payload: expect.objectContaining({
          channelData: {
            matrix: {
              extraContent: {
                "ai.cellect.card": expect.objectContaining({
                  type: "m.cellect.decision",
                  title: "File Lorenzo Personal Financial Statement and REO Schedule",
                  summary: expect.stringContaining(
                    "Link/complete: PFS — Personal financial statement and REO schedule",
                  ),
                  id,
                  workflowRef: `admin-action:${id}`,
                }),
              },
            },
          },
        }),
      }),
    );
  });
  it("requires approval scope and the actual authenticated Fi device, not a supplied device", async () => {
    const h = harness();
    expect(h.scopes.get("fi.adminAction.decide")).toEqual({ scope: "operator.approvals" });
    expect(
      (
        await h.invoke(
          "decide",
          { ...target, decision: "approve", gatewayDeviceId: "real-fi-device" },
          "other-device",
        )
      )[0],
    ).toBe(false);
    expect(h.sendPayload).not.toHaveBeenCalled();
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)).gatewayDeviceId).toBe(
      "other-device",
    );
  });

  it("lets a current administrator approve their own exact request without generic execution", async () => {
    const h = harness();
    const [ok, result] = await h.invoke("decide", { ...target, decision: "approve" });
    expect(ok).toBe(true);
    expect(result).toMatchObject({
      id: "ABC234",
      revision: 2,
      state: "not_executed",
      origin,
      applied: true,
    });
    expect(h.subagentRun).not.toHaveBeenCalled();
    expect(h.sendPayload).toHaveBeenCalledTimes(1);
    expect(
      adminHandoffBlock(
        { adminAgentId: "admin" },
        { toolName: "sandbox_exec", params: { command: "off-target" } },
        { agentId: "admin", sessionKey: "agent:admin:admin-action:abc234" },
      ),
    ).toMatchObject({ block: true });
  });

  it("refuses an ordinary member, revoked membership, or verifier outage", async () => {
    for (const response of [
      Response.json({
        ok: true,
        orgId: origin.orgId,
        matrixUserId: target.requesterMatrixUserId,
        role: "member",
      }),
      new Response(null, { status: 403 }),
      new Response(null, { status: 503 }),
    ]) {
      const h = harness();
      vi.mocked(fetch).mockResolvedValueOnce(response);
      expect((await h.invoke("decide", { ...target, decision: "approve" }))[0]).toBe(false);
      expect(h.sendPayload).not.toHaveBeenCalled();
    }
  });

  it("binds tenant, issuer, conversation, publication and exact revision", async () => {
    for (const change of [
      { tenantOrgId: "other" },
      { agentMxid: "@other:example.test" },
      { roomId: "!other:example.test" },
      { threadRootEventId: "$other" },
      { revision: 2 },
    ]) {
      const h = harness();
      expect((await h.invoke("decide", { ...target, ...change, decision: "approve" }))[0]).toBe(
        false,
      );
      expect(h.sendPayload).not.toHaveBeenCalled();
    }
    const h = harness({ ...record(), publicationEventId: undefined });
    expect((await h.invoke("decide", { ...target, decision: "approve" }))[0]).toBe(false);
  });

  it("holds and resumes in the same durable owner without refreshing expiry", async () => {
    const original = record();
    const h = harness(original);
    expect((await h.invoke("decide", { ...target, decision: "hold" }))[1]).toMatchObject({
      state: "held",
      revision: 2,
    });
    expect((await h.invoke("decide", { ...target, decision: "approve" }))[0]).toBe(false);
    expect(
      (await h.invoke("decide", { ...target, revision: 2, decision: "resume" }))[1],
    ).toMatchObject({ state: "pending", revision: 3 });
    const stored = h.namespaces.get("admin-actions")!.get("ABC234") as AdminActionRecord;
    expect(stored.createdAt).toBe(original.createdAt);
    expect(
      (await h.invoke("decide", { ...target, revision: 3, decision: "decline" }))[1],
    ).toMatchObject({ state: "denied", revision: 4 });
  });

  it("commits once under a decision race and survives publication failure", async () => {
    const h = harness();
    h.sendPayload.mockRejectedValue(new Error("matrix unavailable"));
    const results = await Promise.all([
      h.invoke("decide", { ...target, decision: "approve" }),
      h.invoke("decide", { ...target, decision: "decline" }),
    ]);
    expect(results.filter(([ok]) => ok)).toHaveLength(1);
    expect(h.sendPayload).toHaveBeenCalledTimes(1);
    expect((await h.invoke("describe", target))[1]).toMatchObject({ revision: 2 });
    expect((await h.invoke("decide", { ...target, decision: "approve" }))[0]).toBe(false);
  });

  it("fails closed when the durable commit fails or caller authority is lost while awaiting", async () => {
    const h = harness();
    h.setFailWrites(true);
    expect((await h.invoke("decide", { ...target, decision: "approve" }))[0]).toBe(false);
    expect(h.sendPayload).not.toHaveBeenCalled();
    h.setFailWrites(false);
    vi.mocked(fetch).mockImplementationOnce(async () => {
      h.revoke();
      return Response.json({
        ok: true,
        orgId: origin.orgId,
        matrixUserId: target.requesterMatrixUserId,
        role: "admin",
      });
    });
    expect((await h.invoke("decide", { ...target, decision: "approve" }))[0]).toBe(false);
    expect(h.sendPayload).not.toHaveBeenCalled();
  });
});
