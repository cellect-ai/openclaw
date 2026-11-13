import { expect, it } from "vitest";
import { resolveOpenClawPluginToolInputs } from "../../agents/openclaw-tools.plugin-context.js";
import { isShadowHookRun, shadowHookRunParams } from "../../agents/shadow-hook-tool-policy.js";
import { lookupHookRequesterAttestation } from "../../infra/hook-requester-attestation.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  makeCronSessionEntry,
  mockRunCronFallbackPassthrough,
  resolveCronSessionMock,
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

// `/hooks/agent` builds `sessionTarget: "isolated"` unless the caller asks for
// a persistent session, and Fi's shadow wake does not. The run must still be a
// shadow run: the tool cap, the attestation and the plugins all key on its
// session key, and Fi binds the attestation to exactly `agent:<agent>:<key>`.
it("keeps an isolated shadow hook run on its agent-qualified shadow session", async () => {
  mockRunCronFallbackPassthrough();
  let pluginContext: Record<string, unknown> | undefined;
  const defaultRun = runEmbeddedAgentMock.getMockImplementation();
  runEmbeddedAgentMock.mockImplementation(async (args: Record<string, unknown>) => {
    // The plugin tool context exactly as the embedded runner builds it.
    pluginContext = resolveOpenClawPluginToolInputs({
      options: { runId: args.runId as string, agentSessionKey: args.sessionKey as string },
    }).context as Record<string, unknown>;
    return defaultRun?.(args);
  });
  const result = await runCronIsolatedAgentTurn(
    makeIsolatedAgentParamsFixture({
      agentId: "cellect-fi-user",
      sessionKey: "hook:fi-shadow:thread",
      hookRequesterAttestation: ATTESTATION,
      job: makeIsolatedAgentJobFixture({ sessionTarget: "isolated" }),
    }),
  );
  expect(result).toMatchObject({ status: "ok" });
  const call = runEmbeddedAgentMock.mock.calls[0]?.[0];
  expect(call.sessionKey).toBe("agent:cellect-fi-user:hook:fi-shadow:thread");
  expect(JSON.stringify(call)).not.toContain(ATTESTATION);
  // Still isolated: a fresh session on the shadow row, never a prior transcript.
  expect(resolveCronSessionMock).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionKey: "agent:cellect-fi-user:hook:fi-shadow:thread",
      forceNew: true,
    }),
  );
  // Plugins see the shadow session and its attestation ...
  expect(pluginContext).toMatchObject({
    sessionKey: "agent:cellect-fi-user:hook:fi-shadow:thread",
    hookRequesterAttestation: ATTESTATION,
  });
  // ... and the gateway caps the same run to the two shadow tools.
  expect(shadowHookRunParams(call.sessionKey, { toolsAllow: ["*"] })).toMatchObject({
    toolsAllow: ["fi_user_api", "m365_shadow_mail"],
    disableMessageTool: true,
    disableToolSearch: true,
  });
});

it("reuses one persistent shadow transcript and isolates each turn's attestation and tool cap", async () => {
  mockRunCronFallbackPassthrough();
  const sessionKey = "hook:fi-shadow:thread";
  const qualified = "agent:cellect-fi-user:hook:fi-shadow:thread";
  const firstAttestation = `fsa:job-1:${"A".repeat(43)}`;
  const secondAttestation = `fsa:job-2:${"B".repeat(43)}`;
  let sharedSessionId: string | undefined;
  resolveCronSessionMock.mockImplementation(() => {
    if (!sharedSessionId) {
      const created = makeCronSession();
      sharedSessionId = created.sessionEntry.sessionId;
      return created;
    }
    return makeCronSession({
      isNewSession: false,
      sessionEntry: makeCronSessionEntry({ sessionId: sharedSessionId }),
    });
  });
  const seen: Array<{ runId: string; sessionKey: string; attestation: string | undefined }> = [];
  const defaultRun = runEmbeddedAgentMock.getMockImplementation();
  runEmbeddedAgentMock.mockImplementation(async (args: Record<string, unknown>) => {
    const runId = args.runId as string;
    const runSessionKey = args.sessionKey as string;
    if (seen.length === 1) {
      expect(lookupHookRequesterAttestation(seen[0]?.runId, runSessionKey)).toBeUndefined();
    }
    seen.push({
      runId,
      sessionKey: runSessionKey,
      attestation: lookupHookRequesterAttestation(runId, runSessionKey),
    });
    return defaultRun?.(args);
  });
  const job = makeIsolatedAgentJobFixture({ sessionTarget: `session:${sessionKey}` });

  const first = await runCronIsolatedAgentTurn(
    makeIsolatedAgentParamsFixture({
      agentId: "cellect-fi-user",
      sessionKey,
      hookRequesterAttestation: firstAttestation,
      job,
    }),
  );
  const second = await runCronIsolatedAgentTurn(
    makeIsolatedAgentParamsFixture({
      agentId: "cellect-fi-user",
      sessionKey,
      hookRequesterAttestation: secondAttestation,
      job,
    }),
  );

  expect(first).toMatchObject({ status: "ok", sessionId: sharedSessionId });
  expect(second).toMatchObject({ status: "ok", sessionId: sharedSessionId });
  expect(seen.map((entry) => entry.sessionKey)).toEqual([qualified, qualified]);
  expect(seen[0]?.runId).not.toBe(seen[1]?.runId);
  expect(seen[0]?.attestation).toBe(firstAttestation);
  expect(seen[1]?.attestation).toBe(secondAttestation);
  expect(lookupHookRequesterAttestation(seen[0]?.runId, qualified)).toBeUndefined();
  expect(lookupHookRequesterAttestation(seen[1]?.runId, qualified)).toBeUndefined();
  expect(JSON.stringify(runEmbeddedAgentMock.mock.calls)).not.toContain(firstAttestation);
  expect(JSON.stringify(runEmbeddedAgentMock.mock.calls)).not.toContain(secondAttestation);
  for (const call of resolveCronSessionMock.mock.calls) {
    expect(call[0]).toMatchObject({ sessionKey: qualified, forceNew: false });
  }
  for (const entry of seen) {
    expect(shadowHookRunParams(entry.sessionKey, { toolsAllow: ["*"] })).toMatchObject({
      toolsAllow: ["fi_user_api", "m365_shadow_mail"],
      disableMessageTool: true,
      disableToolSearch: true,
    });
  }
});

it("keeps ordinary isolated hook runs on a random cron run session", async () => {
  mockRunCronFallbackPassthrough();
  await runCronIsolatedAgentTurn(
    makeIsolatedAgentParamsFixture({
      agentId: "cellect-fi-user",
      sessionKey: "hook:fi-mail:thread",
      job: makeIsolatedAgentJobFixture({ sessionTarget: "isolated" }),
    }),
  );
  const call = runEmbeddedAgentMock.mock.calls[0]?.[0];
  expect(call.sessionKey).toMatch(/^agent:cellect-fi-user:cron:test-job:run:[^:]+$/);
  expect(isShadowHookRun(call.sessionKey)).toBe(false);
});

it.each([
  ["rfi", "fsa", "rfi_prepare_draft"],
  ["co", "fcw", "co_prepare_draft"],
])(
  "carries native %s environment and grant only into its exact tool context",
  async (workflow, codec, tool) => {
    mockRunCronFallbackPassthrough();
    const token = `${codec}:construction-job:${"C".repeat(43)}`;
    const sessionKey = `hook:fi-${workflow}:source-operation`;
    let context: Record<string, unknown> | undefined;
    const defaultRun = runEmbeddedAgentMock.getMockImplementation();
    runEmbeddedAgentMock.mockImplementation(async (args: Record<string, unknown>) => {
      context = resolveOpenClawPluginToolInputs({
        options: {
          runId: args.runId as string,
          agentSessionKey: args.sessionKey as string,
        },
      }).context as Record<string, unknown>;
      return defaultRun?.(args);
    });
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        agentId: "cellect-fi-user",
        sessionKey,
        hookRequesterAttestation: token,
        hookRequesterEnvironment: "dev",
        job: makeIsolatedAgentJobFixture({ sessionTarget: "isolated" }),
      }),
    );
    expect(result).toMatchObject({ status: "ok" });
    const call = runEmbeddedAgentMock.mock.calls[0]?.[0];
    expect(context).toMatchObject({
      sessionKey: `agent:cellect-fi-user:${sessionKey}`,
      hookRequesterAttestation: token,
      fiEnvironment: "dev",
    });
    expect(JSON.stringify(call)).not.toContain(token);
    expect(shadowHookRunParams(call.sessionKey, { toolsAllow: ["*"] })).toMatchObject({
      toolsAllow: [tool],
      disableMessageTool: true,
      disableToolSearch: true,
    });
    expect(lookupHookRequesterAttestation(call.runId, call.sessionKey)).toBeUndefined();
  },
);
