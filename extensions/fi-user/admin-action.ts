import { randomBytes } from "node:crypto";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import {
  deliverWiringReceipt,
  publishAdminActionCard,
  prepareAdminActionOrigin,
} from "./admin-action-card.js";
import { prepareRoomFiling, type PreparedRoomFiling } from "./admin-action-filing.js";
import {
  assertRoomAdminNotice,
  roomAdminNotice,
  type RoomAdminChange,
} from "./admin-action-room.js";
import { ADMIN_ACTION_TEXT_LIMIT, createAdminActionRequestSchema } from "./admin-action-schema.js";
import {
  prepareWiringRequest,
  type PreparedWiringRequest,
  type WiringReceipt,
} from "./admin-action-wiring.js";
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
  company_wiring_share: {
    label: "Request receiving wire instructions",
    required: ["companyId", "recipientEmail"],
  },
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
  room_admin: {
    label: "Data-room administration (notice only)",
    // Members, recipients, public links and settings. A notice to an admin to
    // act in Fi: no record, no approval, nothing it could carry out.
    required: ["description"],
  },
} as const;

export type AdminTask = keyof typeof ADMIN_TASKS;
const TASK_NAMES = Object.keys(ADMIN_TASKS) as AdminTask[];

export type AdminActionFields = {
  companyId?: string;
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
  roomChange?: RoomAdminChange;
  displayName?: string;
  roomName?: string;
  order?: string;
  noOrder?: boolean;
  visibility?: "shared" | "internal";
  acknowledgeRestricted?: boolean;
  taskIds?: string[];
  noTask?: boolean;
  completeTaskIds?: string[];
  tags?: string[];
  highlight?: boolean;
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
  status: "pending" | "held" | "approved" | "denied" | "done" | "failed";
  decidedBy?: string;
  revision?: number;
  origin?: { orgId: string; roomId: string; threadRootEventId: string; agentMxid: string };
  publicationEventId?: string;
  preparedFiling?: PreparedRoomFiling;
  preparedWiring?: PreparedWiringRequest;
  execution?: {
    state: "not_executed" | "unknown" | "done";
    operationId: string;
    message: string;
    receipt?: { roomId: string; documentId: string; roomVersion: number; taskIds: string[] };
    wiringReceipt?: WiringReceipt;
    wiringDelivered?: boolean;
  };
};

export const RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Leading mentions ("@Cellect Fi approve X") are allowed; the decision word must come first.
const APPROVAL =
  /^\s*(?:(?:<@[A-Z0-9]+>|@[^\s]+(?:\s+Fi)?)[\s,:]*)*(approve|approved|deny|denied|reject|rejected)\b(?:[\s:#-]+([A-Z0-9]{6}))?\s*[.!]?\s*$/i;

/** Durable owner only: a missing store is not permission to proceed in memory. */
export function adminActionStore(api: OpenClawPluginApi): PluginStateKeyedStore<AdminActionRecord> {
  return api.runtime.state.openKeyedStore<AdminActionRecord>({
    namespace: "admin-actions",
    maxEntries: 1_000,
    defaultTtlMs: RECORD_TTL_MS,
    overflowPolicy: "reject-new",
  });
}

export function remainingAdminActionTtl(record: AdminActionRecord): number {
  const ttl = record.createdAt + RECORD_TTL_MS - Date.now();
  if (ttl <= 0) {
    throw new Error("The approval request expired; prepare a new request.");
  }
  return ttl;
}

export async function loadAdminAction(
  api: OpenClawPluginApi,
  id: string,
): Promise<AdminActionRecord | undefined> {
  const record = await adminActionStore(api).lookup(id);
  if (!record) {
    return undefined;
  }
  // Old versions could commit the claim and fail to update the request. Those
  // decisions remain authoritative; never resurrect them as pending requests.
  const legacy = await api.runtime.state
    .openKeyedStore<{ decision: "approved" | "denied"; decidedBy: string }>({
      namespace: "admin-action-claims",
      maxEntries: 1_000,
      defaultTtlMs: RECORD_TTL_MS,
    })
    .lookup(id);
  return legacy && record.status === "pending" && !record.revision
    ? { ...record, status: legacy.decision, decidedBy: legacy.decidedBy }
    : record;
}

/** All transports share this exact durable revision/decision commit boundary. */
export async function transitionAdminAction(
  api: OpenClawPluginApi,
  record: AdminActionRecord,
  next: AdminActionRecord,
  assertCurrent: () => void,
): Promise<boolean> {
  const owner = adminActionStore(api);
  if (!owner.withCurrent) {
    throw new Error("Durable approval authority is unavailable.");
  }
  const durable = owner.withCurrent({ assertCurrent });
  const observed = await durable.observe(record.id);
  if (!observed.value || JSON.stringify(observed.value) !== JSON.stringify(record)) {
    return false;
  }
  const ttlMs = remainingAdminActionTtl(record);
  assertCurrent();
  const result = await durable.compareAndApply(record.id, observed.comparison, {
    operation: "update",
    action: "set",
    value: next,
    ttlMs,
  });
  return result.status === "applied";
}

/**
 * Whether this Slack approver may decide the request, and if not, why.
 *
 * Decisions are taken only from members of the tenant this runtime serves: Fi
 * must resolve the approver, and `lookupDelegation` refuses any other org and
 * a runtime with no tenant at all. Being listed as an approver is not
 * membership, so a decline is checked too. Current administrators may approve
 * their own requests; an ordinary member cannot escalate themselves. Throws when Fi
 * cannot answer or this runtime has no tenant.
 */
async function approverRefusal(
  config: ResolvedPluginConfig,
  _record: AdminActionRecord,
  sender: string,
  _approve: boolean,
): Promise<"not_a_member" | undefined> {
  const approver = await lookupDelegation(config, { requesterSenderId: sender.toUpperCase() });
  if (!approver || !["admin", "owner"].includes(approver.user.role)) {
    return "not_a_member";
  }
  return undefined;
}

async function pendingInSession(api: OpenClawPluginApi, sessionKey: string) {
  const all = await adminActionStore(api).entries();
  return all
    .map((entry) => entry.value)
    .filter((record) => record.status === "pending" && record.sessionKey === sessionKey);
}

/**
 * Sessions of approved admin actions, mapped to the requester they act for.
 * The on-behalf-of hook reads it; the handoff guard confines these sessions.
 */
export const adminActionSessions = new Map<string, AdminActionRecord>();

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
  if (record.origin) {
    return `${ADMIN_TASKS[record.task].label}\n${describe(record)}\nUse the decision card to Approve, Hold, or Decline. Approval does not itself mean the action completed.`;
  }
  const principals = config.adminPrincipals.map((id) =>
    /^U[A-Z0-9]+$/i.test(id) ? `<@${id}>` : id,
  );
  // Only a reply Slack verified decides a request, so a card posted anywhere
  // else must send the approver to Slack rather than invite a reply in place.
  const where = record.requester.identity.channel === "slack" ? "in this thread" : "in Slack";
  return [
    `Admin action ${record.id} requested by ${requesterMention(record)} (${record.requester.email}): ${ADMIN_TASKS[record.task].label}`,
    describe(record),
    `${principals.join(" ")}${principals.length ? " — " : ""}reply \`approve ${record.id}\` or \`deny ${record.id}\` ${where}. Approval is recorded separately from execution; unsupported actions are not executed.`,
  ]
    .filter(Boolean)
    .join("\n");
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

/** Legacy requests have no enforceable typed effect. Never run their model brief. */
export async function runApprovedAdminAction(api: OpenClawPluginApi, record: AdminActionRecord) {
  await post(
    api,
    record,
    "Approval recorded. Not executed: this request has no supported exact-target operation. Prepare the specific document and destination in Fi; no unrestricted administrator agent was started.",
  );
}

/**
 * Handle an approver's reply. Only a configured approver's own message counts,
 * including a current administrator's own request, and each request is decided once: later
 * or concurrent decisions are ignored with a note in the thread.
 *
 * The reply must be a Slack message whose sender Slack itself named
 * (`senderAuthentication: "verified"`). A relayed or otherwise asserted sender
 * id proves nothing about who typed it, and no other channel reports the fact,
 * so neither can decide a request.
 *
 * `claimed` says the message was an approver's reply to a known request, so it
 * belongs to this flow whatever the outcome and must not also reach an agent as
 * an ordinary turn. Anything else, including an approver's unrelated message
 * that merely starts with "approve", is left for the conversation.
 */
export async function decideAdminApproval(
  api: OpenClawPluginApi,
  event: {
    content?: string;
    senderId?: string;
    senderAuthentication?: "verified" | "asserted";
    sessionKey?: string;
  },
  context: { channelId?: string; sessionKey?: string },
  run: (record: AdminActionRecord) => Promise<void> = (record) =>
    runApprovedAdminAction(api, record),
): Promise<{ claimed: boolean; decided?: AdminActionRecord; text?: string }> {
  const unclaimed = { claimed: false };
  const refused = { claimed: true };
  const config = configFromRuntime(api);
  const sender = event.senderId?.trim() ?? "";
  if (!sender || !config.adminApprovers.some((id) => id.toLowerCase() === sender.toLowerCase())) {
    return unclaimed;
  }
  const match = APPROVAL.exec(event.content ?? "");
  if (!match) {
    return unclaimed;
  }
  const approve = /^approve/i.test(match[1] ?? "");
  const code = match[2]?.toUpperCase();
  let record: AdminActionRecord | undefined;
  try {
    record = code ? await loadAdminAction(api, code) : undefined;
    // An explicit unknown id must never select a different pending request.
    if (!code) {
      const sessionKey = event.sessionKey ?? context.sessionKey;
      const pending = sessionKey ? await pendingInSession(api, sessionKey) : [];
      record = pending.length === 1 ? pending[0] : undefined;
    }
  } catch {
    api.logger.warn(
      "fi-user: approval storage unavailable; decision text consumed without execution",
    );
    return {
      claimed: true,
      text: "The approval store is temporarily unavailable. Nothing was executed; please retry the decision in this conversation.",
    };
  }
  if (!record) {
    return code
      ? {
          claimed: true,
          text: "That approval request was not found or has expired. Nothing was executed; use the current request in its original conversation.",
        }
      : unclaimed;
  }
  if (Date.now() - record.createdAt > RECORD_TTL_MS) {
    return {
      claimed: true,
      text: "This approval request expired. Nothing was executed; prepare a new exact request.",
    };
  }
  const found = record;
  const note = (text: string) => post(api, found, text).catch(() => undefined);
  const alreadyDecided = `Admin action ${found.id} was already decided; this reply was ignored.`;
  if (context.channelId !== "slack" || event.senderAuthentication !== "verified") {
    await note(
      `Admin action ${found.id}: this reply was ignored because Slack did not verify who sent it. Reply in Slack yourself.`,
    );
    return refused;
  }
  if (found.origin) {
    await note(
      "Use this request's decision card in its originating Fi conversation; a Slack reply cannot decide it.",
    );
    return refused;
  }
  if (found.status !== "pending") {
    await note(alreadyDecided);
    return refused;
  }
  let refusal: Awaited<ReturnType<typeof approverRefusal>>;
  try {
    refusal = await approverRefusal(config, found, sender, approve);
  } catch {
    await note(`Admin action ${found.id}: the approver could not be verified; reply again.`);
    return refused;
  }
  if (refusal === "not_a_member") {
    await note(
      `Admin action ${found.id}: this reply was ignored because its sender is not a member of this organization in Fi.`,
    );
    return refused;
  }
  if (!found.sessionKey || found.sessionKey !== (event.sessionKey ?? context.sessionKey)) {
    await note(
      "Reply in the original Slack thread for this approval request; this conversation cannot decide it.",
    );
    return refused;
  }
  const decided: AdminActionRecord = {
    ...found,
    status: approve ? "approved" : "denied",
    decidedBy: sender,
    revision: (found.revision ?? 1) + 1,
    ...(approve
      ? {
          execution: {
            state: "not_executed" as const,
            operationId: `fi-admin-action-${found.id}`,
            message: "No supported exact-target operation.",
          },
        }
      : {}),
  };
  let applied: boolean;
  try {
    applied = await transitionAdminAction(api, found, decided, () => {});
  } catch {
    await note(
      `Admin action ${found.id}: the decision could not be recorded; retry in this thread.`,
    );
    return refused;
  }
  if (!applied) {
    await note(alreadyDecided);
    return refused;
  }
  if (!approve) {
    await post(api, decided, `Admin action ${decided.id} was declined by an administrator.`).catch(
      () => undefined,
    );
    return { claimed: true, decided };
  }
  void run(decided).catch(() => undefined);
  return { claimed: true, decided };
}

const RequestSchema = createAdminActionRequestSchema(
  TASK_NAMES as unknown as readonly [AdminTask, ...AdminTask[]],
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
      "Request a current administrator's decision in this Fi conversation. company_wiring_share requests an accessible company's verified receiving wire instructions for yourself or another named recipient: supply companyId and recipientEmail; only a current owner/admin can approve release of the recipient-verified link. Supply the existing requestId to recover delivery without creating another share. No email or payment is sent. Continue ordinary work under existing grants without approval. restricted_filing supports an exact existing documentId into an exact roomId, with displayName, roomName, section, order or noOrder, visibility, taskIds or noTask, and completion targets. Resolve exact targets first. Unsupported approved requests are not executed. access_request uses Fi's access-request workflow. room_admin (description; optional project, roomId, roomChange) asks an administrator to change a data room's members, recipients, public links or settings in Fi: a notice only, nothing is changed; without a project it uses the channel's bound project or asks once. description and reason: at most 1000 characters each. Never tag or message the admin agent yourself.",
    parameters: RequestSchema,
    async execute(_toolCallId, raw) {
      const input = raw as AdminActionFields & { task: AdminTask; requestId?: string };
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
      for (const field of ["description", "reason"] as const) {
        const length = input[field]?.length ?? 0;
        if (length > ADMIN_ACTION_TEXT_LIMIT) {
          throw new Error(
            `${field} is ${length} characters; the limit is ${ADMIN_ACTION_TEXT_LIMIT}. Shorten it and call again. Nothing was filed.`,
          );
        }
      }
      if (input.task === "room_admin") {
        assertRoomAdminNotice(input);
      }
      const { task: _task, requestId, ...fields } = input;
      if (requestId && input.task !== "company_wiring_share") {
        throw new Error("requestId retries only an existing wiring request.");
      }
      if (input.task === "restricted_filing") {
        fields.destination = filingDestination(fields);
      }
      const { delegation, config, identity } = await exchange(api, context);

      if (input.task === "room_admin") {
        return roomAdminNotice(context, fields, { delegation, config, identity });
      }

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
        revision: 1,
        ...(identity.channel === "matrix"
          ? { origin: prepareAdminActionOrigin(api, context, config) }
          : {}),
      };
      if (requestId) {
        const existing = await loadAdminAction(api, requestId);
        if (
          !record.origin ||
          !existing?.origin ||
          !existing.preparedWiring ||
          existing.task !== "company_wiring_share" ||
          existing.requester.email !== delegation.user.email ||
          JSON.stringify(existing.origin) !== JSON.stringify(record.origin) ||
          existing.preparedWiring?.companyId !== fields.companyId?.trim() ||
          existing.preparedWiring.recipientEmail !== fields.recipientEmail?.trim().toLowerCase()
        ) {
          throw new Error(
            "That wiring request is unavailable to this requester in this conversation.",
          );
        }
        if (
          ["pending", "held"].includes(existing.status) &&
          Date.now() < existing.createdAt + RECORD_TTL_MS
        ) {
          await publishAdminActionCard(api, existing, context.assertInvocationCurrent);
          return jsonResult({
            requestId,
            status: "pending_approval",
            cardPosted: true,
            tellRequester:
              "The existing approval card is posted in this conversation. No link or payment was created.",
          });
        }
        const recovered = await deliverWiringReceipt(
          api,
          existing,
          context.assertInvocationCurrent ?? (() => {}),
        );
        return jsonResult({
          requestId,
          status: recovered.execution?.wiringDelivered ? "done" : "pending_or_unconfirmed",
          tellRequester: recovered.execution?.wiringDelivered
            ? "The approved recipient-verified link is posted in this conversation. No email or payment was sent."
            : "No new share was created. This request is still awaiting approval or its outcome must be reconciled.",
        });
      }
      if (record.origin) {
        if (record.task === "company_wiring_share") {
          record.preparedWiring = await prepareWiringRequest(
            config,
            delegation,
            record,
            context.assertInvocationCurrent ?? (() => {}),
          );
        } else {
          if (
            record.task !== "restricted_filing" ||
            !["admin", "owner"].includes(delegation.user.role)
          ) {
            return jsonResult({
              status: "not_executable",
              cardPosted: false,
              tellRequester:
                "This action needs exact preparation by a current administrator through a supported operation. Nothing was executed and no actionable approval card was posted.",
            });
          }
          record.preparedFiling = await prepareRoomFiling(
            config,
            record,
            context.assertInvocationCurrent ?? (() => {}),
          );
        }
      } else if (record.task === "company_wiring_share") {
        throw new Error(
          "Request receiving wire instructions in the Fi conversation so an owner or admin can review the exact company and recipient.",
        );
      }
      context.assertInvocationCurrent?.();
      const owner = adminActionStore(api);
      const durable = context.assertInvocationCurrent
        ? owner.withCurrent?.({ assertCurrent: context.assertInvocationCurrent })
        : owner;
      if (
        !durable ||
        !(await durable.registerIfAbsent(record.id, record, {
          ttlMs: remainingAdminActionTtl(record),
        }))
      ) {
        throw new Error("The approval request could not be recorded; nothing was executed.");
      }
      const text = approvalCardText(record, config);
      if (record.origin) {
        try {
          await publishAdminActionCard(api, record, context.assertInvocationCurrent);
        } catch (error) {
          if (record.task !== "company_wiring_share") {
            throw error;
          }
          return jsonResult({
            requestId: record.id,
            status: "publication_pending",
            cardPosted: false,
            tellRequester:
              "Your request is retained, but its approval card could not be confirmed. Retry the same task, company and recipient with this requestId. No wire link or payment was created.",
          });
        }
      } else if (context.delivery) {
        await context.delivery.send({ text });
      }
      return jsonResult({
        requestId: record.id,
        status: "pending_approval",
        ...(record.origin || context.delivery
          ? { cardPosted: true }
          : { cardPosted: false, postThisVerbatim: text }),
        tellRequester:
          "Pending a current administrator's decision in this conversation. Approval and verified execution are separate outcomes.",
      });
    },
  };
}

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
  if (inAdminAction) {
    return {
      block: true,
      blockReason:
        "Approved actions execute only through their exact typed operation owner. Generic agent tools cannot mutate or widen an approved request.",
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
