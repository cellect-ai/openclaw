import { describe, expect, it, vi } from "vitest";
import {
  installDelegationFixtures,
  TOKEN,
  MINT_URL,
  plugin,
  fetchMock,
} from "./admin-delegation.test-helpers.js";

installDelegationFixtures();

/** A hook run that named its Fi is answered by that Fi's own route, or its commands do not run. */
describe("the admin agent's delegated token in a hook run", () => {
  it("answers a hook run only from the Fi it named, and never lets its commands fall back to another", async () => {
    const turn = plugin({
      matrixEnvironments: {
        prod: { baseUrl: "https://fi.example.test/fi", brokerTokenEnv: "FIXTURE_BROKER" },
        dev: { baseUrl: "https://dev.fi.example.test/fi", brokerTokenEnv: "FIXTURE_DEV_BROKER" },
      },
    });
    vi.stubEnv("FIXTURE_DEV_BROKER", "synthetic-dev-broker");
    await turn.arrive();
    await turn.start();
    const command = { params: { command: "cellect commands list" } };

    // Unproven, or named without a route here: the sandbox's own Fi is not used instead.
    for (const context of [
      { hostHookFiEnvironment: "dev", runId: "other-run" },
      { hostHookFiEnvironment: "staging" },
    ]) {
      expect(await turn.exec(context, command)).toMatchObject({
        block: true,
        blockReason: expect.stringContaining("answers to the"),
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();

    const dev = await turn.exec({ hostHookFiEnvironment: "dev" }, command);
    expect(dev?.params?.env).toMatchObject({
      FI_DELEGATED_USER_TOKEN: TOKEN,
      FI_APP_URL: "https://dev.fi.example.test/fi",
    });
    expect(fetchMock.mock.calls.at(-1)![0]).toBe(
      "https://dev.fi.example.test/fi/api/openclaw-user-delegation",
    );
    expect((fetchMock.mock.calls.at(-1)![1] as RequestInit).headers).toMatchObject({
      authorization: "Bearer synthetic-dev-broker",
    });

    // The sandbox's own Fi keeps today's behaviour.
    const prod = await turn.exec({ hostHookFiEnvironment: "prod" }, command);
    expect(prod?.params?.env).toMatchObject({
      FI_DELEGATED_USER_TOKEN: TOKEN,
      FI_APP_URL: "https://fi.example.test/fi",
    });
    expect(fetchMock.mock.calls.at(-1)![0]).toBe(MINT_URL);
  });
});
