import type {
  OpenClawPluginApi,
  PluginAgentEventSubscriptionRegistration,
} from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMatrixEntitlements } from "./matrix-entitlements.js";

type Requester = { sessionKey: string; accountId: string; senderId: string; workspaceId: string };
type Resolver = { resolveSender: (requester: Requester) => Promise<string | undefined> };
const senderId = "@speaker:matrix.example";
const sessionKey = "agent:cellect-main:matrix:channel:!room:matrix.example:thread:$root";
const requester = { sessionKey, accountId: "mainprod", senderId, workspaceId: "T12345678" };

function fixture() {
  const hooks = new Map<string, (event: never, context: never) => unknown>();
  const subscriptions: PluginAgentEventSubscriptionRegistration[] = [];
  const contexts = new Map<string, Resolver>();
  const owner = registerMatrixEntitlements(
    createTestPluginApi({
      config: {
        plugins: {
          entries: {
            "fi-user": {
              config: {
                baseUrl: "https://fi.example",
                brokerTokenEnv: "FIXTURE_BROKER",
                tenantOrgId: "tenant-a",
              },
            },
          },
        },
      },
      runtime: {
        channel: {
          runtimeContexts: {
            register: (entry: { channelId: string; capability: string; context: Resolver }) => {
              contexts.set(`${entry.channelId}/${entry.capability}`, entry.context);
              return { dispose: () => contexts.delete(`${entry.channelId}/${entry.capability}`) };
            },
          },
        },
      } as unknown as OpenClawPluginApi["runtime"],
      on: (name, handler) => hooks.set(name, handler as never),
      registerAgentEventSubscription: (subscription) => subscriptions.push(subscription),
    }),
  );
  const resolver = contexts.get("matrix/requester-slack-identity");
  if (!resolver) {
    throw new Error("Matrix requester resolver was not registered");
  }
  return {
    ...resolver,
    owner,
    admit: async (mode: "text" | "voice" = "text", runId = "run-1") =>
      hooks.get("before_agent_reply")?.(
        {} as never,
        {
          runId,
          agentId: "cellect-main",
          accountId: requester.accountId,
          channel: "matrix",
          senderId,
          chatId: "!room:matrix.example:thread:$root",
          sessionKey,
          channelContext: {
            sender: { id: senderId },
            chat: {
              id: "!room:matrix.example",
              ...(mode === "voice" ? { talkThreadRootEventId: "$root" } : { eventId: "$event" }),
            },
          },
        } as never,
      ),
    retire: async () => {
      for (const subscription of subscriptions) {
        await subscription.handle(
          {
            runId: "run-1",
            stream: "lifecycle",
            data: { phase: "end", executionSettled: true },
          } as never,
          {} as never,
        );
      }
    },
  };
}

const admitted = (overrides = {}) => ({
  ok: true,
  agentId: "cellect-main",
  orgId: "tenant-a",
  googleRequester: { matrixUserId: senderId, slackUserId: "U12345678", workspaceId: "T12345678" },
  ...overrides,
});
const response = (body: unknown) => new Response(JSON.stringify(body));

describe("Matrix requester Slack identity capability", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubEnv("FIXTURE_BROKER", "fixture-token");
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ mainprod: "prod" }));
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function requestBody(index: number): unknown {
    const init = fetchMock.mock.calls[index]?.[1];
    if (!init || typeof init.body !== "string") {
      throw new Error(`Expected JSON request ${index + 1}`);
    }
    return JSON.parse(init.body);
  }

  it.each(["text", "voice"] as const)(
    "rechecks the admitted %s sender through Fi",
    async (mode) => {
      const subject = fixture();
      fetchMock.mockImplementation(async () => response(admitted()));
      await subject.admit(mode);
      await expect(subject.resolveSender(requester)).resolves.toBe("U12345678");
      const body = requestBody(1);
      expect(body).toEqual({
        roomId: "!room:matrix.example",
        agentId: "cellect-main",
        ...(mode === "voice"
          ? { mode: "voice", speakerMxid: senderId, threadRootEventId: "$root" }
          : { eventId: "$event" }),
        googleRequester: true,
        recheck: true,
        slackRequesterWorkspace: true,
      });
      expect(requestBody(0)).not.toHaveProperty("googleRequester");
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
      await expect(subject.resolveSender(requester)).resolves.toBeUndefined();
      // Mapping refusals constrain this read; ordinary tool admission remains Fi's decision.
      await expect(
        subject.owner.beforeToolCall({
          runId: "run-1",
          agentId: "cellect-main",
          sessionKey,
          toolName: "message",
          requester: { channel: "matrix", accountId: requester.accountId, senderId },
        }),
      ).resolves.toBeUndefined();
    },
  );

  it.each([
    { sessionKey: sessionKey + "-other" },
    { accountId: "other" },
    { senderId: "@other:matrix.example" },
  ])("requires the exact admitted host tuple: %j", async (overrides) => {
    const subject = fixture();
    await expect(subject.resolveSender(requester)).resolves.toBeUndefined();
    fetchMock.mockResolvedValueOnce(response(admitted()));
    await subject.admit();
    await expect(subject.resolveSender({ ...requester, ...overrides })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a target in another workspace despite a valid org-bound Slack actor", async () => {
    const subject = fixture();
    fetchMock.mockImplementation(async () => response(admitted()));
    await subject.admit();
    await expect(
      subject.resolveSender({ ...requester, workspaceId: "T99999999" }),
    ).resolves.toBeUndefined();
  });

  it("refuses an ambiguous tuple shared by two admitted runs", async () => {
    const subject = fixture();
    fetchMock.mockImplementation(async () => response(admitted()));
    await subject.admit("text", "run-1");
    await subject.admit("text", "run-2");
    await expect(subject.resolveSender(requester)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { orgId: "tenant-b" },
    { agentId: "another-agent" },
    { googleRequester: undefined },
    { googleRequester: { matrixUserId: senderId, slackUserId: "U12345678" } },
    {
      googleRequester: {
        matrixUserId: senderId,
        slackUserId: "U12345678",
        workspaceId: "T99999999",
      },
    },
    { googleRequester: { matrixUserId: "@other:matrix.example", slackUserId: "U12345678" } },
    { googleRequester: { matrixUserId: senderId, slackUserId: "@forged" } },
  ])("rejects an unbound mapping response: %j", async (overrides) => {
    const subject = fixture();
    fetchMock.mockResolvedValueOnce(response(admitted()));
    await subject.admit();
    fetchMock.mockResolvedValueOnce(response(admitted(overrides)));
    await expect(subject.resolveSender(requester)).resolves.toBeUndefined();
  });

  it("does not publish a mapping after its run settles during the Fi request", async () => {
    const subject = fixture();
    fetchMock.mockResolvedValueOnce(response(admitted()));
    await subject.admit();
    let complete!: (reply: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    const pending = subject.resolveSender(requester);
    await subject.retire();
    complete(response(admitted()));
    await expect(pending).resolves.toBeUndefined();
    await expect(subject.resolveSender(requester)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
