import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTHORIZE_URL,
  fetchMock,
  installDelegationFixtures,
  minted,
  mints,
  plugin,
  SLACK_THREAD,
  THREAD,
  TOKEN,
} from "../extensions/fi-user/test-api.js";
import { prepareSystemAgentRunAdmission } from "../src/agents/admitted-run-context.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../src/agents/cron-creator-authority-context.js";
import { buildEmbeddedAgentHookContext } from "../src/agents/embedded-agent-runner/run/agent-hook-context.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../src/agents/tools/gateway-caller-context.js";
import { clearAgentRunContext, registerAgentRunContext } from "../src/infra/agent-run-registry.js";
import {
  beginSessionEffect,
  captureSessionTarget,
} from "../src/sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../src/shared/deferred.js";

installDelegationFixtures();
const AGENT = "cellect-fi-admin";
const RUN = "native-recovery";
const SESSION_ID = "original-session-incarnation";
const SOURCE = "channel-user:v1:original-task";
const owners: Array<{ close: () => void | Promise<void> }> = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) {
    await owner.close();
  }
  clearAgentRunContext(RUN);
  vi.restoreAllMocks();
});

async function nativeContinuation(
  channel = "slack",
  overrides: {
    sessionKey?: string;
    withoutOwner?: boolean;
    wrongSession?: boolean;
    wrongClaim?: boolean;
  } = {},
) {
  const sessionKey = overrides.sessionKey ?? (channel === "matrix" ? THREAD : SLACK_THREAD);
  const interrupted = new AbortController();
  const work = await beginSessionEffect({
    target: captureSessionTarget({
      storeScope: "/fixture/native-requester-continuation/sessions",
      sessionKey,
      incarnation: SESSION_ID,
      agentId: AGENT,
    }),
    run: { runId: RUN, sessionKey, sessionId: SESSION_ID, agentId: AGENT },
    assertAllowed: () => {},
    onInterrupt: (reason) => {
      interrupted.abort(reason);
      work.release();
      return { runId: RUN };
    },
  });
  owners.push({ close: work.release });
  const isCurrent = () => work.isActive() && !interrupted.signal.aborted;
  const admission = prepareSystemAgentRunAdmission(
    {},
    RUN,
    AGENT,
    "requester-yield-continuation",
    () => {
      if (!isCurrent()) throw new Error("native task custody revoked");
    },
  );
  owners.push(admission);
  const admitted = await admission.admit("embedded");
  registerAgentRunContext(RUN, {
    agentId: AGENT,
    sessionKey,
    sessionId: overrides.wrongSession ? "replacement" : SESSION_ID,
  });
  const capability = createCronCreatorAuthorityCapability(
    overrides.wrongClaim ? "unrelated-run" : RUN,
    { kind: "unknown" },
    { source: "channel-owner", isCurrent },
    isCurrent,
    undefined,
    overrides.withoutOwner
      ? undefined
      : {
          isCurrent,
          sourceTurnId: SOURCE,
          channel,
          senderId: channel === "matrix" ? "@admin:matrix.example" : "U0ADMIN001",
          accountId: "adminprod",
          chatId: channel === "matrix" ? "!room:matrix.example" : "C0CHANNEL1",
          eventId: channel === "matrix" ? "$original" : "1792190933.152459",
        },
  )!;
  const settled = createDeferredCore<void>();
  const prepared = createDeferredCore<ReturnType<typeof buildEmbeddedAgentHookContext>>();
  const execution = runWithCronCreatorAuthorityCapability(
    capability,
    () =>
      withGatewayToolCallerIdentity(
        createAdmittedGatewayToolCallerIdentity({
          admittedRunContext: admitted,
          agentId: AGENT,
          sessionKey,
        })!,
        async () => {
          // Exercise the current native requester-owner projector used by admitted
          // continuations, then the real Fi hook. Legacy restart slots are not authority.
          prepared.resolve(
            buildEmbeddedAgentHookContext(
              {
                runId: RUN,
                sessionId: SESSION_ID,
                sessionKey,
                workspaceDir: "/workspace",
                trigger: "memory",
                memoryAudience: undefined,
                sandbox: undefined,
                messageChannel: channel,
                agentAccountId: "adminprod",
              },
              AGENT,
              undefined,
            ),
          );
          await settled.promise;
        },
      ),
    interrupted.signal,
  );
  void execution.catch(prepared.reject);
  owners.push({
    close: async () => {
      settled.resolve();
      await execution;
    },
  });
  return {
    context: await prepared.promise,
    admission,
    revoke: () => {
      interrupted.abort(new Error("native task custody revoked"));
      work.release();
    },
  };
}

describe("native requester continuation through Fi hooks", () => {
  it("renews an expired credential during native continuation without another user message", async () => {
    const turn = plugin();
    const { context } = await nativeContinuation();
    expect(context.senderId).toBeUndefined();
    expect(context.requesterContinuation?.sourceTurnId).toBe(SOURCE);
    await turn.start(context);
    expect((await turn.exec(context))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
    // Expiry removes credential custody, not the native task's original requester.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60 * 1000);
    fetchMock.mockResolvedValueOnce(minted());
    expect((await turn.exec(context))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
    expect(mints()).toHaveLength(2);
    expect(JSON.parse(mints()[1]![1].body)).toMatchObject({ requesterSenderId: "U0ADMIN001" });
    vi.restoreAllMocks();
  });

  it("keeps resumed raw shell work credential-free without reserving the sandbox", async () => {
    const turn = plugin();
    const { context } = await nativeContinuation();
    await turn.start(context);
    const command = "cat /workspace/input.json";
    const tenantRole = "fixture-owned-tenant-context";
    const shell = await turn.exec(context, {
      params: { command, env: { PGOPTIONS: tenantRole, FI_DELEGATED_USER_TOKEN: "replayed" } },
    });
    expect(shell?.block).not.toBe(true);
    expect(shell?.params).toMatchObject({ command, env: { PGOPTIONS: tenantRole } });
    expect(shell?.params.env?.FI_DELEGATED_USER_TOKEN).toBeUndefined();
    expect(mints()).toHaveLength(0);
    await turn.start({
      ...context,
      runId: "unbound-operator",
      requesterContinuation: undefined,
      trigger: "manual",
      senderId: undefined,
    });
    const unbound = await turn.exec({
      ...context,
      runId: "unbound-operator",
      requesterContinuation: undefined,
      requester: undefined,
    });
    expect(unbound?.block).not.toBe(true);
    expect(unbound?.params.env?.FI_DELEGATED_USER_TOKEN).toBeUndefined();
    expect(mints()).toHaveLength(0);
    expect((await turn.exec(context))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
  });

  it("requires a unique native call identity for each resumed CLI credential", async () => {
    const turn = plugin();
    const { context } = await nativeContinuation();
    await turn.start(context);
    expect(
      (await turn.exec({ ...context, toolCallId: undefined }))?.params.env?.FI_DELEGATED_USER_TOKEN,
    ).toBeUndefined();
    expect(mints()).toHaveLength(0);
    const tracked = { ...context, toolCallId: "immutable-cli-1" };
    expect((await turn.exec(tracked))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
    expect((await turn.exec(tracked))?.params.env?.FI_DELEGATED_USER_TOKEN).toBeUndefined();
    expect(mints()).toHaveLength(1);
  });

  it.each(["unbound operator", "wrong session", "wrong claim"])(
    "rejects %s injection",
    async (kind) => {
      const turn = plugin();
      const overrides =
        kind === "unbound operator"
          ? { withoutOwner: true }
          : kind === "wrong session"
            ? { wrongSession: true }
            : { wrongClaim: true };
      const { context } = await nativeContinuation("slack", overrides);
      expect(context.requesterContinuation).toBeUndefined();
      await turn.start({ ...context, senderId: "U0ADMIN001", trigger: "user" });
      expect(JSON.stringify(await turn.exec(context))).not.toContain(TOKEN);
      expect(mints()).toHaveLength(0);
    },
  );

  it.each(["native custody", "session replacement", "run settlement"])(
    "refuses after %s changes",
    async (kind) => {
      const turn = plugin();
      const { context, revoke, admission } = await nativeContinuation();
      await turn.start(context);
      if (kind === "native custody") {
        revoke();
      } else if (kind === "run settlement") {
        admission.close();
      } else {
        registerAgentRunContext(RUN, {
          agentId: AGENT,
          sessionKey: context.sessionKey,
          sessionId: "new-session",
        });
      }
      expect(JSON.stringify(await turn.exec(context))).not.toContain(TOKEN);
      expect(mints()).toHaveLength(0);
    },
  );

  it("rechecks original Matrix event access and revocation before minting", async () => {
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
    const turn = plugin();
    const { context } = await nativeContinuation("matrix");
    await turn.start(context);
    expect(
      (await turn.exec({ ...context, requester: undefined }))?.params.env?.FI_DELEGATED_USER_TOKEN,
    ).toBe(TOKEN);
    const requests = fetchMock.mock.calls.filter(([url]) => url === AUTHORIZE_URL);
    expect(requests.length).toBeGreaterThan(0);
    expect(JSON.parse(requests[0]![1].body)).toMatchObject({
      roomId: "!room:matrix.example",
      eventId: "$original",
    });
    fetchMock.mockImplementation(async () => new Response("{}", { status: 403 }));
    expect(JSON.stringify(await turn.exec({ ...context, requester: undefined }))).not.toContain(
      TOKEN,
    );
    expect(mints()).toHaveLength(1);
  });

  it.each(["admission", "tool", "stripped proof", "allowed"])(
    "rechecks Matrix source-session recovery at %s",
    async (phase) => {
      vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
      const turn = plugin();
      const { context } = await nativeContinuation("matrix", { sessionKey: SLACK_THREAD });
      const denyRoom = () =>
        fetchMock.mockImplementation(async (url: string) =>
          url === AUTHORIZE_URL ? new Response("{}", { status: 403 }) : minted(),
        );
      if (phase === "admission") {
        denyRoom();
      }
      const started = await turn.start(context);
      if (phase === "admission") {
        expect(started).toMatchObject({ handled: true });
        expect((await turn.exec({ ...context, requester: undefined }))?.block).toBe(true);
      } else {
        expect(started).toBeUndefined();
        if (phase === "tool") {
          denyRoom();
        }
        const result = await turn.exec({
          ...context,
          requester: undefined,
          ...(phase === "stripped proof" ? { requesterContinuation: undefined } : {}),
        });
        if (phase === "allowed") {
          expect(result?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
          expect(mints()).toHaveLength(1);
          return;
        }
        expect(result?.block).toBe(true);
      }
      expect(mints()).toHaveLength(0);
    },
  );

  it("does not extend the original task to an operator injection with the same asserted sender", async () => {
    const turn = plugin();
    const { context } = await nativeContinuation();
    await turn.start(context);
    await turn.inject({ sessionKey: context.sessionKey, senderId: "U0ADMIN001" });
    expect(JSON.stringify(await turn.exec(context))).not.toContain(TOKEN);
    expect(mints()).toHaveLength(0);
  });

  it("drops a token whose native custody expired while Fi was checking access", async () => {
    const turn = plugin();
    const { context, revoke } = await nativeContinuation();
    await turn.start(context);
    fetchMock.mockImplementationOnce(async () => {
      revoke();
      return minted();
    });
    expect(JSON.stringify(await turn.exec(context))).not.toContain(TOKEN);
    expect(mints()).toHaveLength(1);
  });
});
