import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installDelegationFixtures,
  TOKEN,
  THREAD,
  thread,
  HELD,
  plugin,
  fetchMock,
  minted,
} from "./admin-delegation.test-helpers.js";

installDelegationFixtures();

describe("the delegated credential's selected Fi origin", () => {
  const DEV = "https://dev.fi.example.test/fi";
  const DEV_MINT = `${DEV}/api/openclaw-user-delegation`;
  const selectedMints = () => fetchMock.mock.calls.filter(([url]) => url === DEV_MINT);
  const selected = (
    agentId = "cellect-fi-admin",
    senderId = "@admin:matrix.example",
    eventId = "$e1",
  ) => {
    const message = thread(senderId, eventId);
    const sessionKey = THREAD.replace("agent:cellect-fi-admin:", `agent:${agentId}:`);
    return {
      arrive: { ...message.arrive, sessionKey },
      start: { ...message.start, agentId, sessionKey, accountId: "admindev" },
      exec: {
        ...message.exec,
        agentId,
        sessionKey,
        requester: { ...message.exec.requester, accountId: "admindev" },
      },
    };
  };
  const create = () =>
    plugin({
      matrixEnvironments: { dev: { baseUrl: `${DEV}///`, brokerTokenEnv: "FIXTURE_DEV_BROKER" } },
    });
  const authorize = (init?: RequestInit) => {
    if (typeof init?.body !== "string") {
      throw new Error("Expected serialized authorization request");
    }
    const body = JSON.parse(init.body) as { agentId: string };
    return new Response(JSON.stringify({ ok: true, agentId: body.agentId, orgId: "org-a" }));
  };
  beforeEach(() => {
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ admindev: "dev" }));
    vi.stubEnv("FIXTURE_DEV_BROKER", "dev-fixture-broker");
    vi.stubEnv("FI_APP_URL", "https://fi.example.test/fi");
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `${DEV}/api/threads/agent-authorize`) {
        return authorize(init);
      }
      if (url === DEV_MINT) {
        return minted();
      }
      throw new Error("Unexpected Fi environment");
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(["cellect-fi-admin", "cellect-main"])(
    "pairs the issued token with dev for the proven %s turn",
    async (agentId) => {
      const turn = create(),
        message = selected(agentId);
      await turn.arrive(message.arrive);
      await turn.start(message.start);
      const result = await turn.exec(message.exec, {
        params: {
          command: "cellect commands list",
          env: { KEEP: "yes", Fi_App_Url: `${DEV}//`, fi_delegated_user_token: "forged" },
        },
      });
      expect(result?.params).toMatchObject({ host: "sandbox", elevated: false });
      expect(result?.params.env).toEqual({
        KEEP: "yes",
        FI_APP_URL: DEV,
        FI_DELEGATED_USER_TOKEN: TOKEN,
        FI_ON_BEHALF_OF: expect.any(String),
      });
      expect(selectedMints()).toHaveLength(1);
      expect(JSON.parse(String(selectedMints()[0]?.[1]?.body))).toEqual({
        requesterMatrixUserId: "@admin:matrix.example",
        agentId: "cellect-fi-admin",
      });
    },
  );

  it.each([
    ["refusal", () => new Response("Forbidden", { status: 403 })],
    [
      "unavailable service",
      () => {
        throw new Error("unreachable");
      },
    ],
    ["invalid token", () => minted({ token: "invalid" })],
    ["expired token", () => minted({ expiresAt: 1 })],
    ["wrong tenant", () => minted({}, { orgId: "org-b" })],
  ] as const)(
    "blocks an eligible dev command after %s instead of using ambient production",
    async (_name, answer) => {
      const turn = create(),
        message = selected();
      await turn.arrive(message.arrive);
      await turn.start(message.start);
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
        url === DEV_MINT ? answer() : authorize(init),
      );
      const result = await turn.exec(message.exec);
      expect(result).toMatchObject({
        block: true,
        blockReason: expect.stringContaining("cannot fall back"),
      });
      expect(result).not.toHaveProperty("params");
      expect(selectedMints()).toHaveLength(1);
    },
  );

  it.each(["https://fi.example.test/fi", "https://other.example.test/fi", 7])(
    "blocks the explicit wrong origin %s without minting",
    async (origin) => {
      const turn = create(),
        message = selected();
      await turn.arrive(message.arrive);
      await turn.start(message.start);
      const result = await turn.exec(message.exec, {
        params: { command: "cellect commands list", env: { Fi_App_Url: origin } },
      });
      expect(result).toMatchObject({ block: true });
      expect(result).not.toHaveProperty("params");
      expect(selectedMints()).toHaveLength(0);
    },
  );

  it("also blocks a proven Superadmin dev turn when Fi refuses its token", async () => {
    const turn = create(),
      message = selected("cellect-main");
    await turn.arrive(message.arrive);
    await turn.start(message.start);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === DEV_MINT ? new Response("Forbidden", { status: 403 }) : authorize(init),
    );
    expect(await turn.exec(message.exec)).toMatchObject({ block: true });
    expect(selectedMints()).toHaveLength(1);
  });

  it("leaves the chosen origin unchanged on the legacy assertion-only path", async () => {
    const turn = plugin();
    const result = await turn.exec(
      {},
      {
        params: {
          command: "cellect commands list",
          env: { Fi_App_Url: "https://operator.example.test/fi" },
        },
      },
    );
    expect(result?.params.env).toEqual({
      Fi_App_Url: "https://operator.example.test/fi",
      FI_ON_BEHALF_OF: expect.any(String),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks when the native admission check consumes the mint budget", async () => {
    vi.useFakeTimers();
    const turn = create(),
      message = selected();
    await turn.arrive(message.arrive);
    await turn.start(message.start);
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      vi.advanceTimersByTime(12_501);
      return authorize(init);
    });
    expect(await turn.exec(message.exec)).toMatchObject({ block: true });
    expect(selectedMints()).toHaveLength(0);
  });

  it("blocks when the admitted run settles while dev is minting", async () => {
    const turn = create(),
      message = selected();
    await turn.arrive(message.arrive);
    await turn.start(message.start);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url !== DEV_MINT) {
        return authorize(init);
      }
      await turn.settle();
      return minted();
    });
    expect(await turn.exec(message.exec)).toMatchObject({ block: true });
  });

  it("does not lend the selected origin or token to a different session", async () => {
    const turn = create(),
      message = selected();
    await turn.arrive(message.arrive);
    await turn.start(message.start);
    const result = await turn.exec({
      ...message.exec,
      sessionKey: `${message.exec.sessionKey}-different`,
    });
    expect(JSON.stringify(result ?? {})).not.toContain(TOKEN);
    expect(result?.params?.env?.FI_APP_URL).toBeUndefined();
    expect(selectedMints()).toHaveLength(0);
  });

  it("pairs a native voice admission with dev and refuses it after its proof settles during mint", async () => {
    const turn = create(),
      message = selected("cellect-main");
    const voice = {
      ...message.start,
      channelContext: {
        sender: { id: "@admin:matrix.example" },
        chat: { id: "!room:matrix.example", talkThreadRootEventId: "$root" },
      },
    };
    await turn.start(voice);
    expect((await turn.exec(message.exec))?.params.env).toMatchObject({
      FI_APP_URL: DEV,
      FI_DELEGATED_USER_TOKEN: TOKEN,
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url !== DEV_MINT) {
        return authorize(init);
      }
      await turn.settle();
      return minted();
    });
    expect(await turn.exec(message.exec)).toMatchObject({ block: true });
  });

  it("keeps another requester out of the sandbox after an issued dev token", async () => {
    const turn = create(),
      message = selected();
    await turn.arrive(message.arrive);
    await turn.start(message.start);
    expect((await turn.exec(message.exec))?.params.env?.FI_APP_URL).toBe(DEV);
    const other = selected("cellect-fi-admin", "@other:matrix.example", "$e2");
    await turn.arrive(other.arrive);
    await turn.start({ ...other.start, runId: "other-run" });
    expect(await turn.exec({ ...other.exec, runId: "other-run" })).toEqual({
      block: true,
      blockReason: HELD,
    });
    expect(selectedMints()).toHaveLength(1);
  });
});
