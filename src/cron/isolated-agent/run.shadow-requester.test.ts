import { expect, it } from "vitest";
import { lookupHookRequesterAttestation } from "../../infra/hook-requester-attestation.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

setupRunCronIsolatedAgentTurnSuite();
const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const ATTESTATION = `fsa:job-1:${"A".repeat(43)}`;

it.each([
  ["hook:fi-shadow:thread", true],
  ["hook:fi-mail:thread", false],
  ["cron:ordinary", false],
])(
  "exposes the shadow attestation as run context only for a shadow hook: %s",
  async (sessionKey, shadow) => {
    mockRunCronFallbackPassthrough();
    let seen: string | undefined;
    const defaultRun = runEmbeddedAgentMock.getMockImplementation();
    runEmbeddedAgentMock.mockImplementation(async (args: Record<string, unknown>) => {
      seen = lookupHookRequesterAttestation(args.runId as string, args.sessionKey as string);
      return defaultRun?.(args);
    });
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        agentId: "cellect-fi-user",
        sessionKey,
        hookRequesterAttestation: ATTESTATION,
        job: makeIsolatedAgentJobFixture({ sessionTarget: `session:${sessionKey}` }),
      }),
    );
    expect(result).toMatchObject({ status: "ok" });
    expect(seen).toBe(shadow ? ATTESTATION : undefined);
    // Never part of what the model, transcript or session history receives.
    const call = runEmbeddedAgentMock.mock.calls[0]?.[0];
    expect(JSON.stringify(call)).not.toContain(ATTESTATION);
    // Released with the run.
    expect(lookupHookRequesterAttestation(call.runId, call.sessionKey)).toBeUndefined();
  },
);
