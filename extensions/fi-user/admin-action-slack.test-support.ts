import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { vi } from "vitest";
import type { SlackAdminOrigin } from "./admin-action-origin.js";
import { handleSlackAdminActionClick } from "./admin-action-slack-handler.js";
import { loadAdminAction, type AdminActionRecord } from "./admin-action.js";
import { approvalStores } from "./admin-action.test-support.js";

const ORG = "org-test";
const REQUESTER = "UREQ00001";
const ADMIN_A = "UADM00001";
const ADMIN_B = "UADM00002";
const THREAD = "1710000000.000100";
const cfg = {
  bindings: [
    { agentId: "cellect-fi-user", match: { channel: "slack", accountId: "fi-user" } },
    { agentId: "cellect-fi-admin", match: { channel: "slack", accountId: "fi-admin" } },
  ],
  channels: {
    slack: {
      accounts: { "fi-user": { botToken: "xoxb-user" }, "fi-admin": { botToken: "xoxb-admin" } },
    },
  },
  plugins: {
    entries: {
      "fi-user": {
        config: {
          tenantOrgId: ORG,
          baseUrl: "https://fi.example.test",
          brokerTokenEnv: "SLACK_APPROVAL_TEST_BROKER",
        },
      },
    },
  },
};
const origin: SlackAdminOrigin = {
  channel: "slack",
  orgId: ORG,
  accountId: "fi-user",
  channelId: "C0CHANNEL1",
  threadTs: THREAD,
  requesterSlackUserId: REQUESTER,
};
const dm = (user: string) => `D${user.slice(1)}`;

function toolContext(overrides: Record<string, unknown> = {}): OpenClawPluginToolContext {
  return {
    agentId: "cellect-fi-user",
    messageChannel: "slack",
    requesterSenderId: REQUESTER,
    agentAccountId: "fi-user",
    nativeChannelId: "C0CHANNEL1",
    sessionKey: `agent:cellect-fi-user:slack:channel:C0CHANNEL1:thread:${THREAD}`,
    deliveryContext: { channel: "slack", to: "C0CHANNEL1", accountId: "fi-user", threadId: THREAD },
    getRuntimeConfig: () => cfg,
    ...overrides,
  } as unknown as OpenClawPluginToolContext;
}

const record = (overrides: Partial<AdminActionRecord> = {}): AdminActionRecord => ({
  id: "ABC234",
  task: "external_share_link",
  fields: {},
  origin,
  revision: 1,
  createdAt: Date.now(),
  status: "pending",
  requester: {
    email: "member@example.test",
    identity: { channel: "slack", requesterSenderId: REQUESTER },
  },
  slackReviewAccountId: "fi-admin",
  slackPublications: [
    { slackUserId: ADMIN_A, channelId: dm(ADMIN_A), ts: "100.1" },
    { slackUserId: ADMIN_B, channelId: dm(ADMIN_B), ts: "100.2" },
  ],
  ...overrides,
});

type Fi = {
  reviewers: string[];
  /** Administrators Fi recognizes, by Slack id. */
  admins: Record<string, { email: string; role: string }>;
  /** Slack channels whose chat.update fails. */
  failUpdates: string[];
};

function harness(
  initial: AdminActionRecord | null = record(),
  fi: Partial<Fi> = {},
  noticeStore?: PluginStateKeyedStore<unknown>,
) {
  const state: Fi = {
    reviewers: [ADMIN_A, ADMIN_B],
    admins: {
      [ADMIN_A]: { email: "a@example.test", role: "admin" },
      [ADMIN_B]: { email: "b@example.test", role: "owner" },
    },
    failUpdates: [],
    ...fi,
  };
  const durable = approvalStores(initial ? { [initial.id]: initial } : {});
  let counter = 0;
  const sendPayload = vi.fn(async (input: { to: string }) => {
    counter += 1;
    return { messageId: `200.${counter}`, target: { kind: "channel", id: dm(input.to.slice(5)) } };
  });
  const sendText = vi.fn(async (input: { to: string }) => ({
    messageId: "300.1",
    ...(input.to.startsWith("user:")
      ? { target: { kind: "channel", id: dm(input.to.slice(5)) } }
      : {}),
  }));
  const lifecycle = new AbortController();
  const api = {
    lifecycle: { signal: lifecycle.signal },
    config: cfg,
    logger: { warn: vi.fn() },
    runtime: {
      config: { current: () => cfg },
      state: {
        openKeyedStore: (options: { namespace: string }) =>
          options.namespace === "admin-action-notices" && noticeStore
            ? noticeStore
            : durable.openKeyedStore(options),
      },
      channel: { outbound: { loadAdapter: async () => ({ sendPayload, sendText }) } },
    },
  } as unknown as OpenClawPluginApi;
  const updates: Array<Record<string, unknown>> = [];
  const authorizeBodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (url === "https://slack.com/api/chat.update") {
        updates.push({ ...body, token: new Headers(init?.headers).get("authorization") });
        return state.failUpdates.includes(body.channel)
          ? Response.json({ ok: false, error: "cant_update_message" })
          : Response.json({ ok: true });
      }
      if (url.endsWith("/admin-action-reviewers")) {
        return Response.json({
          reviewers: state.reviewers.map((slackUserId) => ({ slackUserId })),
        });
      }
      if (url.endsWith("/admin-action-authorize")) {
        authorizeBodies.push(body);
        const admin = state.admins[body.reviewerSlackUserId];
        return admin
          ? Response.json({
              ok: true,
              orgId: ORG,
              slackUserId: body.reviewerSlackUserId,
              role: admin.role,
              email: admin.email,
            })
          : new Response("no", { status: 403 });
      }
      if (url.endsWith("/openclaw-user-delegation")) {
        const admin = state.admins[body.requesterSenderId];
        const member = body.requesterSenderId === REQUESTER;
        return admin || member
          ? Response.json({
              user: {
                email: admin?.email ?? "member@example.test",
                orgSlug: "test",
                orgId: ORG,
                role: admin?.role ?? "member",
              },
              fi: { token: "t", expiresAt: 1_900_000_000 },
              gmail: { enabled: false, mailbox: null },
            })
          : new Response("none", { status: 404 });
      }
      if (url.includes("fi-view/context")) {
        return Response.json({
          resource: { kind: "company", id: "company-a", name: "Company A", synthetic: false },
        });
      }
      return new Response("unexpected", { status: 500 });
    }),
  );
  return { api, state, durable, sendPayload, sendText, updates, authorizeBodies, lifecycle };
}

type Click = { reply: ReturnType<typeof vi.fn>; edit: ReturnType<typeof vi.fn> };
function click(
  h: ReturnType<typeof harness>,
  who: string,
  payload: string,
  ts = who === ADMIN_A ? "100.1" : "100.2",
  onAccount = "fi-admin",
) {
  const spies: Click = { reply: vi.fn(async () => {}), edit: vi.fn(async () => {}) };
  const result = handleSlackAdminActionClick(h.api, {
    accountId: onAccount,
    authority: { assertCurrent() {} },
    senderId: who,
    conversationId: dm(who),
    interaction: { kind: "button", payload, messageTs: ts },
    respond: { reply: spies.reply as never, editMessage: spies.edit as never },
  });
  return { result, ...spies };
}
const stored = async (h: ReturnType<typeof harness>) => (await loadAdminAction(h.api, "ABC234"))!;

export {
  ADMIN_A,
  ADMIN_B,
  cfg,
  click,
  dm,
  harness,
  ORG,
  origin,
  record,
  REQUESTER,
  stored,
  THREAD,
  toolContext,
};
