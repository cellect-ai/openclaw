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
} from "../../../extensions/fi-user/admin-delegation.test-helpers.js";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { buildEmbeddedAgentHookContext } from "../../agents/embedded-agent-runner/run/agent-hook-context.js";
import { buildChannelSourceTurnId } from "../../auto-reply/reply/source-turn-id.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  beginSessionWorkAdmission,
  consumeSessionWorkAdmissionHandoff,
  startSessionWorkAdmissionInterruption,
} from "../../sessions/session-lifecycle-admission.js";
import { buildPersistedUserTurnMessage } from "../../sessions/user-turn-transcript.message.js";
import { bindAgentRestartRecoveryRequesterContext } from "./agent-restart-recovery-context.js";
import { restoreRestartRecoveryRequesterEvent } from "./agent-restart-recovery-requester.js";

installDelegationFixtures();
const AGENT = "cellect-fi-admin";
const RUN = "native-recovery";
const SESSION_ID = "original-session-incarnation";
const SOURCE = "channel-user:v1:original-task";
const owners: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.close();
  clearAgentRunContext(RUN);
  vi.restoreAllMocks();
});

async function nativeRecovery(
  channel = "slack",
  overrides: Record<string, unknown> = {},
  residentEvents?: readonly unknown[],
) {
  const sessionKey =
    typeof overrides.sessionKey === "string"
      ? overrides.sessionKey
      : channel === "matrix"
        ? THREAD
        : SLACK_THREAD;
  const scope = "/fixture/native-requester-continuation/sessions";
  const interrupted = new AbortController();
  const originalWork = await beginSessionWorkAdmission({
    scope,
    identities: [sessionKey, SESSION_ID],
    assertAllowed: () => {},
  });
  owners.push({ close: originalWork.release });
  const work = consumeSessionWorkAdmissionHandoff({
    handoffId: originalWork.createHandoff(),
    scope,
    identities: [sessionKey, SESSION_ID],
    executionRunId: RUN,
    onInterrupt: (reason) => {
      interrupted.abort(reason);
      return { runId: RUN };
    },
  })!;
  const params = {
    isRestartRecoveryResumeRun: true,
    canUseInternalRuntimeHandoff: Boolean(work),
    expectedExistingSessionId: SESSION_ID,
    resolvedSessionId: SESSION_ID,
    runId: RUN,
    agentId: AGENT,
    sessionKey,
    sessionEntry: {
      sessionId: SESSION_ID,
      updatedAt: 1,
      restartRecoveryDeliveryRunId: RUN,
      restartRecoveryDeliverySourceRunId: SOURCE,
      restartRecoveryDeliveryContext: {
        channel,
        to: channel === "matrix" ? "!room:matrix.example" : "C0CHANNEL1",
      },
      restartRecoverySourceIngress: "channel" as const,
      restartRecoveryRequesterSenderId:
        channel === "matrix" ? "@admin:matrix.example" : "U0ADMIN001",
      restartRecoveryRequesterAccountId: "adminprod",
      restartRecoveryRequesterChatId: channel === "matrix" ? "!room:matrix.example" : "C0CHANNEL1",
      restartRecoveryRequesterEventId: channel === "matrix" ? "$original" : "1792190933.152459",
    },
    assertCurrent: () => {
      interrupted.signal.throwIfAborted();
      if (!work.isActive()) throw new Error("native task custody revoked");
    },
    ...overrides,
  };
  const admission = prepareSystemAgentRunAdmission({}, RUN, AGENT, "main-session-restart-recovery");
  owners.push(admission);
  const admitted = await admission.admit("embedded");
  // This is the production gateway recovery/admission composition, followed by the real
  // embedded hook projector and Fi handlers. No new channel dispatch or sender is supplied.
  bindAgentRestartRecoveryRequesterContext(
    admitted,
    residentEvents
      ? {
          ...params,
          sessionEntry: restoreRestartRecoveryRequesterEvent(params.sessionEntry, residentEvents),
        }
      : params,
  );
  registerAgentRunContext(RUN, { agentId: AGENT, sessionKey, sessionId: SESSION_ID });
  const context = buildEmbeddedAgentHookContext(
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
  );
  return {
    context,
    admission,
    revoke: () => {
      startSessionWorkAdmissionInterruption({
        scope,
        identities: [sessionKey, SESSION_ID],
        executionRunId: RUN,
        reason: new Error("native task custody revoked"),
      });
    },
  };
}

describe("native requester continuation through Fi hooks", () => {
  it("renews an expired credential after deployment without another user message", async () => {
    const turn = plugin();
    const { context } = await nativeRecovery();
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

  it.each(["unbound operator", "wrong session", "wrong claim"])(
    "rejects %s injection",
    async (kind) => {
      const turn = plugin();
      const overrides =
        kind === "unbound operator"
          ? { canUseInternalRuntimeHandoff: false }
          : kind === "wrong session"
            ? { expectedExistingSessionId: "replacement" }
            : { runId: "unrelated-run" };
      const { context } = await nativeRecovery("slack", overrides);
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
      const { context, revoke, admission } = await nativeRecovery();
      await turn.start(context);
      if (kind === "native custody") revoke();
      else if (kind === "run settlement") admission.close();
      else
        registerAgentRunContext(RUN, {
          agentId: AGENT,
          sessionKey: context.sessionKey,
          sessionId: "new-session",
        });
      expect(JSON.stringify(await turn.exec(context))).not.toContain(TOKEN);
      expect(mints()).toHaveLength(0);
    },
  );

  it("rechecks original Matrix event access and revocation before minting", async () => {
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
    const turn = plugin();
    const { context } = await nativeRecovery("matrix");
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
      const { context } = await nativeRecovery("matrix", { sessionKey: SLACK_THREAD });
      const denyRoom = () =>
        fetchMock.mockImplementation(async (url: string) =>
          url === AUTHORIZE_URL ? new Response("{}", { status: 403 }) : minted(),
        );
      if (phase === "admission") denyRoom();
      const started = await turn.start(context);
      if (phase === "admission") {
        expect(started).toMatchObject({ handled: true });
        expect((await turn.exec({ ...context, requester: undefined }))?.block).toBe(true);
      } else {
        expect(started).toBeUndefined();
        if (phase === "tool") denyRoom();
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
    const { context } = await nativeRecovery();
    await turn.start(context);
    await turn.inject({ sessionKey: context.sessionKey, senderId: "U0ADMIN001" });
    expect(JSON.stringify(await turn.exec(context))).not.toContain(TOKEN);
    expect(mints()).toHaveLength(0);
  });

  it("admits the resident's prefixed Matrix recovery target from its exact original event", async () => {
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
    const source = buildChannelSourceTurnId({
      provider: "matrix",
      accountId: "adminprod",
      conversationId: "room:!room:matrix.example",
      messageId: "$original",
    })!;
    const sessionEntry = {
      sessionId: SESSION_ID,
      updatedAt: 1,
      restartRecoveryDeliveryRunId: RUN,
      restartRecoveryDeliverySourceRunId: source,
      restartRecoveryDeliveryContext: {
        channel: "matrix",
        to: "room:!room:matrix.example",
        accountId: "adminprod",
      },
      restartRecoverySourceIngress: "channel" as const,
      restartRecoveryRequesterSenderId: "@admin:matrix.example",
      restartRecoveryRequesterAccountId: "adminprod",
    };
    const original = {
      message: buildPersistedUserTurnMessage({
        text: "Original pending work",
        idempotencyKey: source,
        sender: { id: "@admin:matrix.example" },
        transport: { channel: "matrix", messageId: "$original", conversationRef: "conv_original" },
      }),
    };
    const turn = plugin();
    const { context } = await nativeRecovery("matrix", { sessionEntry }, [original]);
    expect(context.requesterContinuation?.chatId).toBe("!room:matrix.example");
    await turn.start(context);
    expect(
      (await turn.exec({ ...context, requester: undefined }))?.params.env?.FI_DELEGATED_USER_TOKEN,
    ).toBe(TOKEN);
    expect(mints()).toHaveLength(1);
  });

  it("drops a token whose native custody expired while Fi was checking access", async () => {
    const turn = plugin();
    const { context, revoke } = await nativeRecovery();
    await turn.start(context);
    fetchMock.mockImplementationOnce(async () => {
      revoke();
      return minted();
    });
    expect(JSON.stringify(await turn.exec(context))).not.toContain(TOKEN);
    expect(mints()).toHaveLength(1);
  });
});
