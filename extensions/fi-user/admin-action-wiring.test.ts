import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeApprovedWiringRequest, prepareWiringRequest } from "./admin-action-wiring.js";
import type { AdminActionRecord } from "./admin-action.js";
import type { Delegation, ResolvedPluginConfig } from "./fi-delegation.js";

function fetchUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

const config = { baseUrl: "https://fi.example.test/fi" } as ResolvedPluginConfig;
const member = {
  user: { orgSlug: "test", email: "member@example.test", role: "member" },
  fi: { token: "member-token" },
} as Delegation;
const admin = {
  user: { orgSlug: "test", email: "admin@example.test", role: "admin" },
  fi: { token: "admin-token" },
} as Delegation;
const record = {
  task: "company_wiring_share",
  fields: { companyId: "company-a", recipientEmail: "other@example.test" },
  origin: {},
} as AdminActionRecord;
const prepared = {
  companyId: "company-a",
  companyName: "Company A",
  recipientEmail: "other@example.test",
};
const show = {
  ownerKind: "company",
  ownerId: "company-a",
  defaults: [
    {
      purpose: "investment_funding",
      instructionId: "instruction-a",
      verificationStatus: "verified",
      effectiveTo: null,
    },
  ],
};
const share = {
  applied: true,
  companyId: "company-a",
  recipientEmail: "other@example.test",
  instruction: { instructionVersionId: "instruction-a" },
  url: "https://fi.example.test/fi/s/code",
  expiresAt: "2026-12-01T00:00:00Z",
};

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

describe("recipient-bound wire requests", () => {
  it.each(["member@example.test", "other@example.test"])(
    "prepares a request to %s using only the member's company grants",
    async (recipientEmail) => {
      vi.mocked(fetch).mockResolvedValue(
        Response.json({
          resource: { kind: "company", id: "company-a", name: "Company A", synthetic: false },
        }),
      );
      expect(
        await prepareWiringRequest(
          config,
          member,
          { ...record, fields: { ...record.fields, recipientEmail } },
          () => {},
        ),
      ).toEqual({ ...prepared, recipientEmail });
      const [url, request] = vi.mocked(fetch).mock.calls[0]!;
      expect(fetchUrl(url)).toContain("/api/test/fi-view/context?");
      expect(new Headers(request!.headers).get("authorization")).toBe("Bearer member-token");
      expect(request?.method).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("refuses inaccessible or synthetic companies before any request publication", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(prepareWiringRequest(config, member, record, () => {})).rejects.toThrow(
      "current grants",
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        resource: { kind: "company", id: "company-a", name: "All companies", synthetic: true },
      }),
    );
    await expect(prepareWiringRequest(config, member, record, () => {})).rejects.toThrow(
      "one real company",
    );
  });
  it("uses the approver's token and exact current default for the existing typed share operation", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ ok: true, result: show }))
      .mockResolvedValueOnce(Response.json({ ok: true, result: share }));
    expect(
      await executeApprovedWiringRequest(config, admin, prepared, "operation-one", () => {}),
    ).toMatchObject({
      state: "done",
      wiringReceipt: { ...prepared, instructionVersionId: "instruction-a", url: share.url },
    });
    for (const [, request] of vi.mocked(fetch).mock.calls) {
      expect(new Headers(request!.headers).get("authorization")).toBe("Bearer admin-token");
    }
    const body = vi.mocked(fetch).mock.calls[1]![1]!.body;
    expect(body).toBeInstanceOf(FormData);
    expect(JSON.parse((body as FormData).get("input") as string)).toEqual({
      actor: admin.user.email,
      companyId: prepared.companyId,
      recipientEmail: prepared.recipientEmail,
      expectedInstructionId: "instruction-a",
    });
  });
  it("does not release a missing, unverified or retired receiving default", async () => {
    for (const defaults of [
      [],
      [{ ...show.defaults[0], verificationStatus: "pending" }],
      [{ ...show.defaults[0], effectiveTo: "2026-11-03" }],
    ]) {
      vi.mocked(fetch).mockResolvedValueOnce(
        Response.json({ ok: true, result: { ...show, defaults } }),
      );
      expect(
        await executeApprovedWiringRequest(config, admin, prepared, "operation-one", () => {}),
      ).toMatchObject({ state: "not_executed" });
    }
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("never reports a substituted recipient, company, version or external URL as delivered", async () => {
    for (const changed of [
      { recipientEmail: "attacker@example.test" },
      { companyId: "other" },
      { instruction: { instructionVersionId: "other" } },
      { url: "https://attacker.test/s/code" },
    ]) {
      vi.mocked(fetch)
        .mockResolvedValueOnce(Response.json({ ok: true, result: show }))
        .mockResolvedValueOnce(Response.json({ ok: true, result: { ...share, ...changed } }));
      expect(
        await executeApprovedWiringRequest(config, admin, prepared, "operation-one", () => {}),
      ).toMatchObject({ state: "unknown" });
    }
  });
  it("does not replay an uncertain share and checks invocation authority before effects", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ ok: true, result: show }))
      .mockRejectedValueOnce(new Error("response lost"));
    expect(
      await executeApprovedWiringRequest(config, admin, prepared, "operation-one", () => {}),
    ).toMatchObject({ state: "unknown" });
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.mocked(fetch).mockClear();
    expect(
      await executeApprovedWiringRequest(config, admin, prepared, "operation-one", () => {
        throw new Error("revoked");
      }),
    ).toMatchObject({ state: "unknown" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
