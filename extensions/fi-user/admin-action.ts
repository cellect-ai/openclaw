import { randomBytes } from "node:crypto";
import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import {
  configFromRuntime,
  delegatedJson,
  exchange,
  lookupDelegation,
  type RequesterIdentity,
  type ResolvedPluginConfig,
} from "./fi-delegation.js";

/**
 * The fixed menu of things fi-user may ask an administrator to do. Anything a
 * requester could do in Fi under their own grants is a fi-user tool instead;
 * these widen access or reach outside the requester's grants.
 */
export const ADMIN_TASKS = {
  esign_change_recipient: {
    label: "Change an e-sign recipient",
    required: ["project", "submissionId", "currentSignerEmail", "newSignerEmail"],
  },
  esign_prepare_template: {
    label: "Prepare an e-sign template",
    required: ["project", "documentId", "description"],
  },
  external_share_link: {
    label: "Share a document outside Fi",
    required: ["project", "documentId", "recipientEmail"],
  },
  document_outside_grants: {
    label: "Retrieve a document outside the requester's grants",
    required: ["project", "description"],
  },
  restricted_filing: {
    label: "File a restricted document",
    // Destination: a data room (roomId) or, without one, the project's
    // document library (optional category/section). See filingDestination.
    required: ["project", "description"],
  },
  access_request: {
    label: "Access request",
    required: ["targetType"],
  },
} as const;
export type AdminTask = keyof typeof ADMIN_TASKS;
const TASK_NAMES = Object.keys(ADMIN_TASKS) as AdminTask[];

export type AdminActionFields = {
  project?: string;
  submissionId?: number;
  currentSignerEmail?: string;
  newSignerEmail?: string;
  documentId?: string;
  recipientEmail?: string;
  roomId?: string;
  destination?: FilingDestination;
  category?: string;
  section?: string;
  slackFileId?: string;
  description?: string;
  targetType?: "org" | "project" | "company";
  targetId?: string;
  reason?: string;
};

export type FilingDestination = "data_room" | "project_library";

/**
 * Where a restricted filing goes: a data room needs its roomId; with no room
 * it goes to the project's document library. An explicit destination that
 * contradicts the fields is refused rather than guessed.
 */
export function filingDestination(fields: AdminActionFields): FilingDestination {
  const destination = fields.destination ?? (fields.roomId ? "data_room" : "project_library");
  if (destination === "data_room" && !fields.roomId) {
    throw new Error("restricted_filing to a data room requires: roomId");
  }
  if (destination === "project_library" && fields.roomId) {
    throw new Error(
      "restricted_filing to the project library takes no roomId; omit roomId or set destination data_room",
    );
  }
  return destination;
}

export type AdminActionRecord = {
  id: string;
  task: AdminTask;
  fields: AdminActionFields;
  requester: { email: string; identity: RequesterIdentity | { channel: "unknown" } };
  sessionKey?: string;
  delivery?: { channel?: string; to?: string; accountId?: string; threadId?: string | number };
  createdAt: number;
  status: "pending" | "approved" | "denied" | "done" | "failed";
  decidedBy?: string;
};

const RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ADMIN_RUN_TIMEOUT_MS = 20 * 60 * 1000;
// Leading mentions ("@Cellect Fi approve X") are allowed; the decision word must come first.
const APPROVAL =
  /^\s*(?:(?:<@[A-Z0-9]+>|@[^\s]+(?:\s+Fi)?)[\s,:]*)*(approve|approved|deny|denied|reject|rejected)\b[\s:#-]*([A-Z0-9]{6})?\b/i;

/** Pending requests; persisted when the runtime grants a keyed store. */
const records = new Map<string, AdminActionRecord>();
type Store = {
  register(key: string, value: AdminActionRecord, opts?: { ttlMs?: number }): Promise<void>;
  lookup(key: string): Promise<AdminActionRecord | undefined>;
  entries(): Promise<Array<{ key: string; value: AdminActionRecord }>>;
};
let store: Store | null | undefined;

function openStore(api: OpenClawPluginApi): Store | null {
  if (store !== undefined) {
    return store;
  }
  try {
    store = api.runtime.state.openKeyedStore<AdminActionRecord>({
      namespace: "admin-actions",
      maxEntries: 1_000,
      defaultTtlMs: RECORD_TTL_MS,
    }) as Store;
  } catch {
    store = null;
  }
  return store;
}

async function save(api: OpenClawPluginApi, record: AdminActionRecord) {
  records.set(record.id, record);
  await openStore(api)
    ?.register(record.id, record, { ttlMs: RECORD_TTL_MS })
    .catch(() => undefined);
}

async function load(api: OpenClawPluginApi, id: string): Promise<AdminActionRecord | undefined> {
  return (
    records.get(id) ??
    (await openStore(api)
      ?.lookup(id)
      .catch(() => undefined))
  );
}

type DecisionClaim = { decision: "approved" | "denied"; decidedBy: string; at: number };
type ClaimStore = {
  registerIfAbsent(key: string, value: DecisionClaim, opts?: { ttlMs?: number }): Promise<boolean>;
};
let claimStore: ClaimStore | null | undefined;
/** Requests decided in this process; checked and set with no await in between. */
const claimed = new Set<string>();

function openClaimStore(api: OpenClawPluginApi): ClaimStore | null {
  if (claimStore !== undefined) {
    return claimStore;
  }
  try {
    claimStore = api.runtime.state.openKeyedStore<DecisionClaim>({
      namespace: "admin-action-claims",
      maxEntries: 1_000,
      defaultTtlMs: RECORD_TTL_MS,
    }) as ClaimStore;
  } catch {
    claimStore = null;
  }
  return claimStore;
}

/**
 * Take the one decision a request gets. The in-process set is the atomic
 * step; the durable compare-and-set carries it across restarts. A decision
 * that cannot be recorded durably is released so the approver can retry.
 */
async function claimDecision(
  api: OpenClawPluginApi,
  record: AdminActionRecord,
  claim: DecisionClaim,
): Promise<"claimed" | "taken" | "unrecorded"> {
  const current = records.get(record.id) ?? record;
  if (current.status !== "pending" || claimed.has(record.id)) {
    return "taken";
  }
  claimed.add(record.id);
  const durable = openClaimStore(api);
  if (!durable) {
    return "claimed";
  }
  try {
    return (await durable.registerIfAbsent(record.id, claim, { ttlMs: RECORD_TTL_MS }))
      ? "claimed"
      : "taken";
  } catch {
    claimed.delete(record.id);
    return "unrecorded";
  }
}

/** Whether this approver is the person who filed the request, on any channel. */
async function isOwnRequest(
  config: ResolvedPluginConfig,
  record: AdminActionRecord,
  sender: string,
): Promise<boolean> {
  const identity = record.requester.identity;
  const requesterId =
    identity.channel === "slack"
      ? identity.requesterSenderId
      : identity.channel === "matrix"
        ? identity.requesterMatrixUserId
        : undefined;
  if (requesterId?.toLowerCase() === sender.toLowerCase()) {
    return true;
  }
  // The same person may have filed on another channel: compare Fi identities.
  const approver = await lookupDelegation(
    config,
    sender.startsWith("@")
      ? { requesterMatrixUserId: sender }
      : { requesterSenderId: sender.toUpperCase() },
  );
  return approver?.user.email.trim().toLowerCase() === record.requester.email.trim().toLowerCase();
}

async function pendingInSession(api: OpenClawPluginApi, sessionKey: string) {
  const all = new Map(records);
  for (const entry of (await openStore(api)
    ?.entries()
    .catch(() => [])) ?? []) {
    if (!all.has(entry.key)) {
      all.set(entry.key, entry.value);
    }
  }
  return [...all.values()].filter(
    (record) => record.status === "pending" && record.sessionKey === sessionKey,
  );
}

/**
 * Sessions of approved admin actions, mapped to the requester they act for.
 * The on-behalf-of hook reads it; the handoff guard confines these sessions.
 */
export const adminActionSessions = new Map<string, AdminActionRecord>();

export function adminActionSessionKey(
  config: Pick<ResolvedPluginConfig, "adminAgentId">,
  id: string,
) {
  return `agent:${config.adminAgentId}:admin-action:${id.toLowerCase()}`;
}

function describe(record: AdminActionRecord): string {
  const f = record.fields;
  const lines = [
    f.project ? `Project: ${f.project}` : undefined,
    f.submissionId ? `E-sign envelope: ${f.submissionId}` : undefined,
    f.currentSignerEmail ? `Current signer: ${f.currentSignerEmail}` : undefined,
    f.newSignerEmail ? `New signer: ${f.newSignerEmail}` : undefined,
    f.documentId ? `Document: ${f.documentId}` : undefined,
    f.recipientEmail ? `Share with: ${f.recipientEmail}` : undefined,
    f.roomId ? `Data room: ${f.roomId}` : undefined,
    record.task === "restricted_filing" && f.destination === "project_library"
      ? `Destination: the project's document library (not a data room)${f.category ? `, category ${f.category}` : ""}${f.section ? `, section ${f.section}` : ""}`
      : undefined,
    f.slackFileId ? `Slack file: ${f.slackFileId}` : undefined,
    f.targetType ? `Access to: ${f.targetType}${f.targetId ? ` ${f.targetId}` : ""}` : undefined,
    f.description ? `What: ${f.description}` : undefined,
    f.reason ? `Why: ${f.reason}` : undefined,
  ];
  return lines.filter(Boolean).join("\n");
}

function requesterMention(record: AdminActionRecord): string {
  const identity = record.requester.identity;
  return identity.channel === "slack" ? `<@${identity.requesterSenderId}>` : record.requester.email;
}

export function approvalCardText(record: AdminActionRecord, config: ResolvedPluginConfig): string {
  const principals = config.adminPrincipals.map((id) =>
    /^U[A-Z0-9]+$/i.test(id) ? `<@${id}>` : id,
  );
  return [
    `Admin action ${record.id} requested by ${requesterMention(record)} (${record.requester.email}): ${ADMIN_TASKS[record.task].label}`,
    describe(record),
    `${principals.join(" ")}${principals.length ? " — " : ""}reply \`approve ${record.id}\` or \`deny ${record.id}\` in this thread. On approval Cellect Fi Admin carries out only this request.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The fi-admin brief: exactly one task, no follow-on work, no handoff. */
export function adminActionBrief(record: AdminActionRecord): string {
  return [
    `Approved admin action ${record.id}: ${ADMIN_TASKS[record.task].label}.`,
    `Requested by ${record.requester.email}; approved by ${record.decidedBy ?? "an administrator"}.`,
    describe(record),
    ...(record.task === "restricted_filing"
      ? [
          record.fields.destination === "project_library"
            ? "File it into that project's document library as a restricted document, under the category/section given (if any); do not add it to any data room."
            : "File it into the data room named above as a restricted document.",
        ]
      : []),
    "",
    "Carry out ONLY this task, as specified above, attributed to the requester. Do not widen it, do not start other work, and do not hand it or any part of it to another agent or session. If it cannot be done exactly as specified, stop and say why.",
    "Finish with one short message stating what you did and the result the requester should see (links or ids), or why you stopped.",
  ].join("\n");
}

async function post(api: OpenClawPluginApi, record: AdminActionRecord, text: string) {
  const delivery = record.delivery;
  if (!delivery?.channel || !delivery.to) {
    api.logger.warn(`fi-user: admin action ${record.id} has no delivery route`);
    return;
  }
  const adapter = await api.runtime.channel.outbound.loadAdapter(delivery.channel);
  if (!adapter?.sendText) {
    api.logger.warn(`fi-user: no outbound adapter for ${delivery.channel}`);
    return;
  }
  const cfg = (api.runtime.config?.current?.() ?? api.config) as typeof api.config;
  await adapter.sendText({
    cfg,
    to: delivery.to,
    text,
    ...(delivery.threadId !== undefined ? { threadId: delivery.threadId } : {}),
    ...(delivery.accountId ? { accountId: delivery.accountId } : {}),
  });
}

function lastAssistantText(messages: unknown[]): string | undefined {
  for (const message of messages.toReversed()) {
    const entry = message as {
      role?: unknown;
      content?: unknown;
      message?: { role?: unknown; content?: unknown };
    };
    const item = entry.message ?? entry;
    if (item.role !== "assistant") {
      continue;
    }
    if (typeof item.content === "string" && item.content.trim()) {
      return item.content.trim();
    }
    if (Array.isArray(item.content)) {
      const text = item.content
        .map((part) => {
          const value = (part as { type?: unknown; text?: unknown } | null) ?? {};
          return value.type === "text" && typeof value.text === "string" ? value.text : "";
        })
        .join("")
        .trim();
      if (text) {
        return text;
      }
    }
  }
  return undefined;
}

/** Start the single approved fi-admin turn and report its outcome in the thread. */
export async function runApprovedAdminAction(api: OpenClawPluginApi, record: AdminActionRecord) {
  const config = configFromRuntime(api);
  const sessionKey = adminActionSessionKey(config, record.id);
  adminActionSessions.set(sessionKey, record);
  try {
    const run = await api.runtime.subagent.run({
      sessionKey,
      message: adminActionBrief(record),
      extraSystemPrompt:
        "This session carries out one administrator-approved request from a Fi user. Do only that request. Never hand off, message other agents, or spawn sessions.",
      deliver: false,
      idempotencyKey: `fi-admin-action-${record.id.toLowerCase()}`,
    });
    const waited = await api.runtime.subagent.waitForRun({
      runId: run.runId,
      timeoutMs: ADMIN_RUN_TIMEOUT_MS,
    });
    const { messages } = await api.runtime.subagent.getSessionMessages({ sessionKey, limit: 20 });
    const outcome =
      lastAssistantText(messages) ??
      `Run finished (${(waited as { status?: string }).status ?? "unknown"}) without a summary.`;
    await save(api, { ...record, status: "done" });
    await post(
      api,
      record,
      `Admin action ${record.id} — requested by ${requesterMention(record)}, approved by ${record.decidedBy}:\n${outcome}`,
    );
  } catch (error) {
    await save(api, { ...record, status: "failed" });
    await post(
      api,
      record,
      `Admin action ${record.id} could not be completed: ${error instanceof Error ? error.message : String(error)}`,
    ).catch(() => undefined);
  } finally {
    adminActionSessions.delete(sessionKey);
  }
}

/**
 * Handle an approver's reply. Only a configured approver's own message counts,
 * never the requester's own approval, and each request is decided once: later
 * or concurrent decisions are ignored with a note in the thread.
 */
export async function handleAdminApprovalMessage(
  api: OpenClawPluginApi,
  event: { content?: string; senderId?: string; sessionKey?: string },
  context: { channelId?: string; sessionKey?: string },
  run: (record: AdminActionRecord) => Promise<void> = (record) =>
    runApprovedAdminAction(api, record),
): Promise<AdminActionRecord | undefined> {
  const config = configFromRuntime(api);
  const sender = event.senderId?.trim() ?? "";
  if (!sender || !config.adminApprovers.some((id) => id.toLowerCase() === sender.toLowerCase())) {
    return undefined;
  }
  const match = APPROVAL.exec(event.content ?? "");
  if (!match) {
    return undefined;
  }
  const approve = /^approve/i.test(match[1] ?? "");
  const code = match[2]?.toUpperCase();
  let record: AdminActionRecord | undefined = code ? await load(api, code) : undefined;
  // A word after "approve" that is not a request id falls back to the thread.
  if (!record) {
    const sessionKey = event.sessionKey ?? context.sessionKey;
    const pending = sessionKey ? await pendingInSession(api, sessionKey) : [];
    record = pending.length === 1 ? pending[0] : undefined;
  }
  if (!record || Date.now() - record.createdAt > RECORD_TTL_MS) {
    return undefined;
  }
  const found = record;
  const note = (text: string) => post(api, found, text).catch(() => undefined);
  const alreadyDecided = `Admin action ${found.id} was already decided; this reply was ignored.`;
  if (found.status !== "pending" || claimed.has(found.id)) {
    await note(alreadyDecided);
    return undefined;
  }
  if (approve) {
    let own: boolean;
    try {
      own = await isOwnRequest(config, found, sender);
    } catch {
      await note(`Admin action ${found.id}: the approver could not be verified; reply again.`);
      return undefined;
    }
    if (own) {
      await note(
        `Admin action ${found.id} cannot be approved by the person who requested it; another administrator must approve it.`,
      );
      return undefined;
    }
  }
  const decided: AdminActionRecord = {
    ...found,
    status: approve ? "approved" : "denied",
    decidedBy: sender,
  };
  const claim = await claimDecision(api, found, {
    decision: decided.status as DecisionClaim["decision"],
    decidedBy: sender,
    at: Date.now(),
  });
  if (claim === "taken") {
    await note(alreadyDecided);
    return undefined;
  }
  if (claim === "unrecorded") {
    await note(`Admin action ${found.id}: the decision could not be recorded; reply again.`);
    return undefined;
  }
  records.set(decided.id, decided);
  await save(api, decided);
  if (!approve) {
    await post(api, decided, `Admin action ${decided.id} was declined by an administrator.`).catch(
      () => undefined,
    );
    return decided;
  }
  void run(decided).catch(() => undefined);
  return decided;
}

const RequestSchema = Type.Object(
  {
    task: stringEnum(TASK_NAMES as unknown as readonly [AdminTask, ...AdminTask[]], {
      description:
        "esign_change_recipient | esign_prepare_template | external_share_link | document_outside_grants | restricted_filing | access_request",
    }),
    project: Type.Optional(Type.String({ maxLength: 200 })),
    submissionId: Type.Optional(Type.Integer({ minimum: 1 })),
    currentSignerEmail: Type.Optional(Type.String({ format: "email" })),
    newSignerEmail: Type.Optional(Type.String({ format: "email" })),
    documentId: Type.Optional(Type.String({ maxLength: 200 })),
    recipientEmail: Type.Optional(Type.String({ format: "email" })),
    roomId: Type.Optional(
      Type.String({
        maxLength: 200,
        description: "restricted_filing into a data room. Omit to file into the project library.",
      }),
    ),
    destination: Type.Optional(
      stringEnum(["data_room", "project_library"] as const, {
        description:
          "restricted_filing: data_room (needs roomId) or project_library. Default: data_room when roomId is given, else project_library.",
      }),
    ),
    category: Type.Optional(
      Type.String({
        maxLength: 50,
        description: "restricted_filing to a project library: category.",
      }),
    ),
    section: Type.Optional(
      Type.String({
        maxLength: 200,
        description: "restricted_filing to a project library: section.",
      }),
    ),
    slackFileId: Type.Optional(Type.String({ pattern: "^F[A-Za-z0-9]{6,}$" })),
    description: Type.Optional(Type.String({ maxLength: 1_000 })),
    targetType: Type.Optional(stringEnum(["org", "project", "company"] as const)),
    targetId: Type.Optional(Type.String({ maxLength: 200 })),
    reason: Type.Optional(Type.String({ maxLength: 1_000 })),
  },
  { additionalProperties: false },
);

function newId(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return [...randomBytes(6)].map((byte) => alphabet[byte % alphabet.length]).join("");
}

export function createRequestAdminActionTool(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext,
): AnyAgentTool {
  return {
    name: "request_admin_action",
    label: "Ask an administrator",
    description:
      "Ask Alex or Lorenzo to approve one administrator action you cannot do as the requester: esign_change_recipient, esign_prepare_template, external_share_link, document_outside_grants, restricted_filing (into a data room with roomId, or into a project's document library with no roomId and optional category/section), or access_request. Posts an approval card in this conversation; after approval Cellect Fi Admin carries out only that task and reports back here. access_request files a Fi access request that an administrator approves in Fi. Never tag or message the admin agent yourself.",
    parameters: RequestSchema,
    async execute(_toolCallId, raw) {
      const input = raw as AdminActionFields & { task: AdminTask };
      const task = ADMIN_TASKS[input.task];
      if (!task) {
        throw new Error("Unknown admin task");
      }
      const missing = task.required.filter((field) => {
        const value = (input as Record<string, unknown>)[field];
        return value === undefined || value === "";
      });
      if (missing.length > 0) {
        throw new Error(`${input.task} requires: ${missing.join(", ")}`);
      }
      const { task: _task, ...fields } = input;
      if (input.task === "restricted_filing") {
        fields.destination = filingDestination(fields);
      }
      const { delegation, config, identity } = await exchange(api, context);

      if (input.task === "access_request") {
        const created = (await delegatedJson(
          config,
          delegation,
          `/api/${encodeURIComponent(delegation.user.orgSlug)}/access-requests`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              requesterEmail: delegation.user.email,
              target: { type: input.targetType, ...(input.targetId ? { id: input.targetId } : {}) },
              ...(input.reason ? { reason: input.reason } : {}),
              sourceRef: context.sessionKey ?? "openclaw:cellect-fi-user",
            }),
          },
          "Fi access request",
        )) as { request?: { id?: unknown }; approvalUrl?: string };
        const principals = config.adminPrincipals.map((id) =>
          /^U[A-Z0-9]+$/i.test(id) ? `<@${id}>` : id,
        );
        const text = [
          `Access request from ${identity.channel === "slack" ? `<@${identity.requesterSenderId}>` : delegation.user.email} (${delegation.user.email}): ${input.targetType}${input.targetId ? ` ${input.targetId}` : ""}${input.reason ? ` — ${input.reason}` : ""}`,
          `${principals.join(" ")}${principals.length ? " — " : ""}approve or deny in Fi: ${created.approvalUrl ?? "(Settings → Access requests)"}`,
        ].join("\n");
        if (context.delivery) {
          await context.delivery.send({ text });
        }
        return jsonResult({
          filed: true,
          request: created.request,
          approvalUrl: created.approvalUrl,
          ...(context.delivery
            ? { cardPosted: true }
            : { cardPosted: false, postThisVerbatim: text }),
          tellRequester:
            "Filed in Fi; Alex or Lorenzo decides. Nothing is granted until they approve.",
        });
      }

      const record: AdminActionRecord = {
        id: newId(),
        task: input.task,
        fields,
        requester: { email: delegation.user.email, identity },
        ...(context.sessionKey ? { sessionKey: context.sessionKey } : {}),
        ...(context.deliveryContext
          ? {
              delivery: {
                channel: context.deliveryContext.channel,
                to: context.deliveryContext.to,
                accountId: context.deliveryContext.accountId,
                threadId: context.deliveryContext.threadId,
              },
            }
          : {}),
        createdAt: Date.now(),
        status: "pending",
      };
      await save(api, record);
      const text = approvalCardText(record, config);
      if (context.delivery) {
        await context.delivery.send({ text });
      }
      return jsonResult({
        requestId: record.id,
        status: "pending_approval",
        ...(context.delivery
          ? { cardPosted: true }
          : { cardPosted: false, postThisVerbatim: text }),
        tellRequester:
          "Pending approval by Alex or Lorenzo; the result will be posted in this thread.",
      });
    },
  };
}

/** Tools through which an agent could pass work to another agent or session. */
const HANDOFF_TOOLS = new Set([
  "sessions_send",
  "sessions_spawn",
  "subagents",
  "request_admin_action",
]);

/**
 * fi-admin never hands work off. An approved admin-action session is confined
 * further: no messaging tool either, so the outcome is reported only by the
 * plugin in the original thread.
 */
export function adminHandoffBlock(
  config: Pick<ResolvedPluginConfig, "adminAgentId">,
  event: { toolName: string; params: Record<string, unknown> },
  ctx: { agentId?: string; sessionKey?: string },
): { block: true; blockReason: string } | undefined {
  if (ctx.agentId !== config.adminAgentId) {
    return undefined;
  }
  const inAdminAction =
    Boolean(ctx.sessionKey && adminActionSessions.has(ctx.sessionKey)) ||
    Boolean(ctx.sessionKey?.startsWith(`agent:${config.adminAgentId}:admin-action:`));
  if (inAdminAction && (HANDOFF_TOOLS.has(event.toolName) || event.toolName === "message")) {
    return {
      block: true,
      blockReason:
        "An approved admin action runs only its own task; it cannot hand off or message elsewhere.",
    };
  }
  if (event.toolName === "sessions_send") {
    return {
      block: true,
      blockReason: "Cellect Fi Admin does not hand work off to other agents or sessions.",
    };
  }
  if (event.toolName === "sessions_spawn" || event.toolName === "subagents") {
    const target = typeof event.params.agentId === "string" ? event.params.agentId.trim() : "";
    if (target && target !== config.adminAgentId) {
      return {
        block: true,
        blockReason: "Cellect Fi Admin does not hand work off to other agents.",
      };
    }
  }
  return undefined;
}
