import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  approvedRoomFiling,
  prepareRoomFiling,
  requestedRoomFiling,
  executeApprovedRoomFiling,
  verifiedFilingReceipt,
} from "./admin-action-filing.js";
import type { AdminActionRecord } from "./admin-action.js";
import type { Delegation, ResolvedPluginConfig } from "./fi-delegation.js";

const record: AdminActionRecord = {
  id: "ABC234",
  task: "restricted_filing",
  requester: { email: "requester@example.test", identity: { channel: "unknown" } },
  createdAt: 1,
  status: "approved",
  fields: {
    destination: "data_room",
    documentId: "doc-exact",
    roomId: "room-exact",
    roomName: "Investor room",
    displayName: "Signed agreement",
    section: "Legal",
    order: "3",
    visibility: "shared",
    acknowledgeRestricted: true,
    taskIds: ["task-exact"],
    completeTaskIds: ["task-exact"],
  },
};
const input = requestedRoomFiling(record, "approver@example.test")!;
const preparation = {
  expectedRoomVersion: 3,
  sourceSha256: "a".repeat(64),
  sourceUpdatedAt: "2026-10-21T00:00:00.000Z",
};
const config = { baseUrl: "https://fi.example.test" } as ResolvedPluginConfig;
const delegation = {
  user: { orgSlug: "test", email: "approver@example.test" },
  fi: { token: "private-delegation" },
} as Delegation;
const receipt = () => ({
  applied: true,
  operation: "file",
  actor: input.actor,
  room: input.room,
  verifiedRoomVersion: 4,
  placement: {
    documentId: input.document,
    displayName: input.displayName,
    roomCategory: input.section,
    orderKey: input.order,
    visibility: input.visibility,
    tags: [],
    isHighlighted: false,
  },
  verifiedDocument: {
    documentId: input.document,
    displayName: input.displayName,
    roomCategory: input.section,
    orderKey: input.order,
    visibility: input.visibility,
    tags: [],
    isHighlighted: false,
  },
  verifiedTasks: [{ id: "task-exact", documentIds: ["doc-exact"], status: "resolved" }],
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

describe("one exact typed filing effect", () => {
  it("rejects a misleading room label before publishing or executing an approval", async () => {
    vi.stubEnv("FILING_TEST_BROKER", "test-broker");
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        user: { email: record.requester.email, role: "admin", orgId: "org-test", orgSlug: "test" },
        fi: { token: "admin-token", expiresAt: 1_900_000_000 },
        gmail: { enabled: false, mailbox: null },
      }),
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        ok: true,
        result: {
          ...receipt(),
          applied: false,
          actor: record.requester.email,
          expectedRoomVersion: 3,
          taskIds: ["task-exact"],
          completeTaskIds: ["task-exact"],
          preparedTarget: {
            room: { id: input.room, name: "Different actual room" },
            document: {
              id: input.document,
              filename: "source.pdf",
              sha256: preparation.sourceSha256,
              sourceUpdatedAt: preparation.sourceUpdatedAt,
            },
            tasks: [{ id: "task-exact", title: "Actual checklist target", complete: true }],
          },
        },
      }),
    );
    await expect(
      prepareRoomFiling(
        { ...config, tenantOrgId: "org-test", brokerTokenEnv: "FILING_TEST_BROKER" },
        {
          ...record,
          requester: {
            ...record.requester,
            identity: { channel: "matrix", requesterMatrixUserId: "@admin:example.test" },
          },
        },
        () => {},
      ),
    ).rejects.toThrow("room name does not match");
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1]![1]!.body)).dryRun).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("requires the canonical order and tags frozen before approval", () => {
    const canonical = receipt();
    canonical.placement.orderKey = "2.01";
    canonical.verifiedDocument.orderKey = "2.01";
    expect(verifiedFilingReceipt({ ...input, order: "2.01" }, canonical)).toBe(true);
    expect(verifiedFilingReceipt({ ...input, order: "2.1" }, canonical)).toBe(false);
    canonical.verifiedDocument.orderKey = "9.01";
    expect(verifiedFilingReceipt({ ...input, order: "2.1" }, canonical)).toBe(false);
  });
  it("requires explicit placement and checklist choices and cannot substitute another target", () => {
    expect(
      requestedRoomFiling(
        { ...record, fields: { ...record.fields, order: undefined } },
        input.actor,
      ),
    ).toBeUndefined();
    expect(
      requestedRoomFiling({ ...record, fields: { ...record.fields, taskIds: [] } }, input.actor),
    ).toBeUndefined();
    expect(approvedRoomFiling(record, input.actor)).toBeUndefined();
    expect(verifiedFilingReceipt(input, { ...receipt(), room: "other-room" })).toBe(false);
    expect(
      verifiedFilingReceipt(input, {
        ...receipt(),
        verifiedDocument: { ...receipt().verifiedDocument, documentId: "other-doc" },
      }),
    ).toBe(false);
    expect(verifiedFilingReceipt(input, { ...receipt(), verifiedTasks: [] })).toBe(false);
  });
  it("uses the genuine approver token and only reports done after authoritative readback", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ ok: true, result: receipt() }));
    expect(
      await executeApprovedRoomFiling(
        config,
        delegation,
        input,
        "operation-one",
        () => {},
        preparation,
      ),
    ).toMatchObject({
      state: "done",
      operationId: "operation-one",
      receipt: { roomId: "room-exact", documentId: "doc-exact", roomVersion: 4 },
    });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("https://fi.example.test/api/test/admin-room-filing");
    expect(JSON.parse(String(init!.body))).toEqual({
      input: { ...input, preparation },
      dryRun: false,
    });
    expect(new Headers(init!.headers).get("authorization")).toBe("Bearer private-delegation");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["timeout-no-effect", "lost-response-after-effect"])(
    "keeps %s unknown without replay",
    async () => {
      vi.mocked(fetch).mockRejectedValue(new Error("response unavailable"));
      expect(
        await executeApprovedRoomFiling(
          config,
          delegation,
          input,
          "operation-one",
          () => {},
          preparation,
        ),
      ).toMatchObject({ state: "unknown" });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("does not dispatch after authority is revoked", async () => {
    await expect(
      executeApprovedRoomFiling(
        config,
        delegation,
        input,
        "operation-one",
        () => {
          throw new Error("revoked");
        },
        preparation,
      ),
    ).rejects.toThrow("revoked");
    expect(fetch).not.toHaveBeenCalled();
  });
});
