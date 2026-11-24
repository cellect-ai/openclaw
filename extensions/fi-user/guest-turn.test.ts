import { readFileSync } from "node:fs";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGuestApiTool,
  guestToolAttestation,
  guestTurnConfig,
  reportGuestTurn,
} from "./guest-turn.js";

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

describe("guestTurnConfig", () => {
  const runtime = {
    baseUrl: "https://app.example.test/fi",
    brokerTokenEnv: "PROD_BROKER",
    tenantOrgId: "org_1",
    matrixEnvironments: {
      dev: { baseUrl: "https://dev.example.test/fi/", brokerTokenEnv: "DEV_BROKER" },
    },
  };

  it("uses only the named environment's own origin and broker", () => {
    expect(guestTurnConfig(runtime, "dev")).toEqual({
      baseUrl: "https://dev.example.test/fi",
      brokerTokenEnv: "DEV_BROKER",
      tenantOrgId: "org_1",
    });
  });

  it("never falls back to the top-level configuration", () => {
    for (const environment of [undefined, "prod" as const, "staging" as const]) {
      expect(() => guestTurnConfig(runtime, environment)).toThrow("not configured");
    }
    expect(() =>
      guestTurnConfig(
        { ...runtime, matrixEnvironments: { dev: { baseUrl: " ", brokerTokenEnv: "X" } } },
        "dev",
      ),
    ).toThrow("not configured");
  });

  it("keeps a tenant conflict so the broker refuses", () => {
    process.env.DEV_BROKER = "x";
    try {
      const config = guestTurnConfig({ ...runtime, tenantOrgConflict: true }, "dev");
      expect(config.tenantOrgConflict).toBe(true);
    } finally {
      delete process.env.DEV_BROKER;
    }
  });
});

describe("guest_api tool contract", () => {
  it("is declared in the plugin manifest, or the host drops it and a guest turn has no tool", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { contracts: { tools: string[] } };
    const tool = createGuestApiTool(
      {} as OpenClawPluginApi,
      { sessionKey: SESSION } as OpenClawPluginToolContext,
      ATTESTATION,
    );
    expect(manifest.contracts.tools).toContain(tool.name);
  });
});

describe("guest_api paths", () => {
  const tool = () =>
    createGuestApiTool(
      {} as OpenClawPluginApi,
      { sessionKey: SESSION, agentId: "cellect-fi-guest" } as OpenClawPluginToolContext,
      ATTESTATION,
    );

  it("offers exactly the two guest reads Fi serves", () => {
    const { parameters } = tool();
    for (const path of ["resources", "outstanding"]) {
      expect(Value.Check(parameters, { path })).toBe(true);
    }
    for (const path of ["conversation", "documents", "resources/1", "", "../resources"]) {
      expect(Value.Check(parameters, { path })).toBe(false);
    }
  });

  it.each(["conversation", "documents", "resources/x", "/resources", "../outstanding", ""])(
    "refuses %j before any request",
    async (path) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(tool().execute("call-1", { path })).rejects.toThrow(
        "path must be 'resources' or 'outstanding'",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
