import { createHash } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePersonalReviewDelivery } from "./review-delivery.js";

const input = {
  reviewAttestation: "pra:synthetic-review:fixture",
  childSessionKey: "agent:cellect-fi-user:hook:fi-review:fixture",
  resultText: "Synthetic private review.\nDecision: wait.",
};
const owner = {
  ownerEmail: "owner@example.test",
  roomId: "!main:example.test",
  jobId: "review-job",
};
const routing = {
  baseUrl: "https://fi.example.test/fi/",
  brokerTokenEnv: "synthetic-private-token",
};
const fetchMock = vi.fn<typeof fetch>();
function config(raw: Record<string, unknown>): OpenClawConfig {
  return { plugins: { entries: { "fi-user": { config: raw } } } } as OpenClawConfig;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, ...owner })));
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("accepted review delivery uses canonical Fi tenant configuration", () => {
  it.each([
    { tenantOrgId: "org-a" },
    { matrixTenantOrgId: "org-a" },
    { tenantOrgId: "org-a", matrixTenantOrgId: "org-a" },
    { tenantOrgId: " org-a ", matrixTenantOrgId: "org-a " },
  ])("resolves current or legacy tenant routing: %j", async (tenant) => {
    await expect(
      resolvePersonalReviewDelivery(config({ ...routing, ...tenant }), input),
    ).resolves.toEqual(owner);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://fi.example.test/fi/api/personal-agent/background-delivery");
    expect(request).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer synthetic-private-token",
        "content-type": "application/json",
      },
      cache: "no-store",
    });
    expect(JSON.parse(request!.body as string)).toEqual({
      reviewAttestation: input.reviewAttestation,
      sessionKey: input.childSessionKey,
      resultDigest: createHash("sha256").update(input.resultText).digest("hex"),
    });
  });

  it("preserves the environment-name private broker form", async () => {
    vi.stubEnv("TEST_REVIEW_BROKER", "synthetic-env-token");
    await resolvePersonalReviewDelivery(
      config({ ...routing, tenantOrgId: "org-a", brokerTokenEnv: "TEST_REVIEW_BROKER" }),
      input,
    );
    expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({
      authorization: "Bearer synthetic-env-token",
    });
  });

  it.each([
    { ...routing, tenantOrgId: "org-a", matrixTenantOrgId: "org-b" },
    { ...routing },
    { ...routing, tenantOrgId: "org-a", operatorAgentId: "cellect-main" },
    { ...routing, tenantOrgId: "org-a", operatorAgentId: "unknown-operator" },
    { ...routing, tenantOrgId: "org-a", operatorAgentId: "" },
    { ...routing, tenantOrgId: "org-a", operatorAgentId: null },
    { tenantOrgId: "org-a", brokerTokenEnv: routing.brokerTokenEnv },
    { tenantOrgId: "org-a", baseUrl: routing.baseUrl },
    { ...routing, tenantOrgId: "org-a", baseUrl: " " },
    { ...routing, tenantOrgId: "org-a", brokerTokenEnv: " " },
    { ...routing, tenantOrgId: "org-a", brokerTokenEnv: "TEST_REVIEW_MISSING_BROKER" },
  ])("rejects unavailable or ambiguous routing before callback: %j", async (raw) => {
    vi.stubEnv("TEST_REVIEW_MISSING_BROKER", "");
    await expect(resolvePersonalReviewDelivery(config(raw), input)).rejects.toThrow(
      "review_delivery_unavailable",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { ok: false, ...owner },
    { ok: true, ...owner, ownerEmail: "invalid" },
    { ok: true, ...owner, roomId: "not-a-room" },
    { ok: true, ...owner, jobId: null },
  ])("does not release an unverified callback owner: %j", async (body) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body)));
    await expect(
      resolvePersonalReviewDelivery(config({ ...routing, tenantOrgId: "org-a" }), input),
    ).rejects.toThrow("review_delivery_forbidden");
  });

  it("rejects a non-successful callback even with a valid owner shape", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, ...owner }), { status: 403 }),
    );
    await expect(
      resolvePersonalReviewDelivery(config({ ...routing, tenantOrgId: "org-a" }), input),
    ).rejects.toThrow("review_delivery_forbidden");
  });
});
