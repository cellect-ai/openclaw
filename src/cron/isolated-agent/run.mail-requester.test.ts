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

it.each(["session:hook:fi-mail:thread", "isolated"])(
  "binds generic mail source receipt to this exact active run without prompt/job persistence: %s",
  async (sessionTarget) => {
    const { resolveOpenClawPluginToolInputs } =
      await import("../../agents/openclaw-tools.plugin-context.js");
    const { lookupMailWakeSourceLock } = await import("../../infra/mail-wake-source-lock.js");
    mockRunCronFallbackPassthrough();
    const receipt = `slw:job-fi-mail:${"a".repeat(43)}`;
    let context: Record<string, unknown> | undefined;
    const original = runEmbeddedAgentMock.getMockImplementation();
    runEmbeddedAgentMock.mockImplementation(async (args: Record<string, unknown>) => {
      context = resolveOpenClawPluginToolInputs({
        options: { runId: String(args.runId), agentSessionKey: String(args.sessionKey) },
      }).context;
      expect(context.hookSourceLockCapability).toBe(receipt);
      expect(context.hostMailWakeEnvironment).toBe("prod");
      expect(lookupMailWakeSourceLock("another-run", String(args.sessionKey))).toBeUndefined();
      expect(JSON.stringify(args)).not.toContain(receipt);
      return original?.(args);
    });
    const job = makeIsolatedAgentJobFixture({ sessionTarget });
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        agentId: "cellect-fi-admin",
        sessionKey: "hook:fi-mail:thread",
        sourceLockCapability: receipt,
        hookRequesterEnvironment: "prod",
        mailRequesterSenderId: "U0ADMIN001",
        job,
      }),
    );
    expect(result.status).toBe("ok");
    expect(context?.hookSourceLockCapability).toBe(receipt);
    expect(JSON.stringify(job)).not.toContain(receipt);
    const call = runEmbeddedAgentMock.mock.calls[0]?.[0];
    expect(lookupMailWakeSourceLock(call.runId, call.sessionKey)).toBeUndefined();
  },
);
