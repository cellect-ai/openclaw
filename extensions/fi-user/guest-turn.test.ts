import { afterEach, describe, expect, it, vi } from "vitest";
import { guestToolAttestation, reportGuestTurn } from "./guest-turn.js";

const SESSION = `hook:fi-guest:${"a".repeat(40)}`;
const ATTESTATION = `fga:gt_1:${"C".repeat(43)}`;
const config = {
  baseUrl: "https://fi.test/fi",
  brokerTokenEnv: "GUEST_TEST_BROKER_TOKEN",
  tenantOrgId: "org_1",
};
const completion = {
  runId: "run-1",
  sessionKey: SESSION,
  attestation: ATTESTATION,
  status: "ok" as const,
  outputText: "  Your packet is ready.  ",
};

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GUEST_TEST_BROKER_TOKEN;
});

describe("guestToolAttestation", () => {
  it("accepts only a guest receipt on a guest session", () => {
    expect(
      guestToolAttestation({ sessionKey: SESSION, hookRequesterAttestation: ATTESTATION }),
    ).toBe(ATTESTATION);
    expect(
      guestToolAttestation({
        sessionKey: "hook:fi-shadow:x",
        hookRequesterAttestation: ATTESTATION,
      }),
    ).toBeUndefined();
    expect(
      guestToolAttestation({
        sessionKey: SESSION,
        hookRequesterAttestation: `fsa:j:${"A".repeat(43)}`,
      }),
    ).toBeUndefined();
    expect(guestToolAttestation({ sessionKey: SESSION })).toBeUndefined();
  });
});

describe("reportGuestTurn", () => {
  it("posts the reply with the broker credential and retries transport failures", async () => {
    process.env.GUEST_TEST_BROKER_TOKEN = "broker-secret";
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("reset"))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ok: true, replay: false }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(reportGuestTurn(config, completion, [0, 0, 0])).resolves.toBe("reported");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [url, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(url).toBe("https://fi.test/fi/api/access/v1/guest-turns/report");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer broker-secret");
    expect(JSON.parse(init.body as string)).toEqual({
      guestTurnAttestation: ATTESTATION,
      sessionKey: SESSION,
      reply: { text: "Your packet is ready." },
    });
    // A run is reported once even if completion is delivered again.
    await expect(reportGuestTurn(config, completion, [0])).resolves.toBe("skipped");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a refusal and reports nothing for failed or silent turns", async () => {
    process.env.GUEST_TEST_BROKER_TOKEN = "broker-secret";
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      reportGuestTurn(config, { ...completion, runId: "run-2" }, [0, 0]),
    ).rejects.toThrow("403");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const skipped of [
      { status: "error" as const },
      { outputText: "NO_REPLY" },
      { outputText: "   " },
      { outputText: undefined },
    ]) {
      await expect(
        reportGuestTurn(config, { ...completion, runId: "run-3", ...skipped }, [0]),
      ).resolves.toBe("skipped");
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to report without a broker credential or tenant org", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(reportGuestTurn(config, { ...completion, runId: "run-4" }, [0])).rejects.toThrow(
      "broker",
    );
    process.env.GUEST_TEST_BROKER_TOKEN = "x";
    await expect(
      reportGuestTurn(
        { ...config, tenantOrgId: undefined },
        { ...completion, runId: "run-5" },
        [0],
      ),
    ).rejects.toThrow("broker");
  });
});
