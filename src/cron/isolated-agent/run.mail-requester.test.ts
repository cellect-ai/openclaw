import { expect, it } from "vitest";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

setupRunCronIsolatedAgentTurnSuite();
const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

it.each(["hook:fi-mail:thread", "cron:ordinary"])(
  "carries the accepted mail requester only in its hook execution: %s",
  async (sessionKey) => {
    mockRunCronFallbackPassthrough();
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        agentId: "cellect-fi-admin",
        sessionKey,
        mailRequesterSenderId: "U0ADMIN001",
        job: makeIsolatedAgentJobFixture({ sessionTarget: `session:${sessionKey}` }),
      }),
    );
    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "cellect-fi-admin",
        trigger: "cron",
        ...(sessionKey.startsWith("hook:fi-mail:") ? { senderId: "U0ADMIN001" } : {}),
      }),
    );
    if (!sessionKey.startsWith("hook:fi-mail:")) {
      expect(runEmbeddedAgentMock.mock.calls[0]?.[0].senderId).toBeUndefined();
    }
  },
);
