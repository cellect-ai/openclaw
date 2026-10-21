import type { AdminActionRecord } from "./admin-action.js";
import {
  delegatedFetch,
  lookupDelegation,
  FI_ADMIN_DELEGATION_AGENT_ID,
  type Delegation,
  type ResolvedPluginConfig,
} from "./fi-delegation.js";

export type ApprovedRoomFiling = {
  actor: string;
  room: string;
  document: string;
  displayName: string;
  section: string;
  order?: string;
  noOrder: boolean;
  visibility: "shared" | "internal";
  acknowledgeRestricted: boolean;
  task: string[];
  noTask: boolean;
  completeTask: string[];
  tag: string[];
  highlight: boolean;
};

export type PreparedRoomFiling = {
  input: Omit<ApprovedRoomFiling, "actor">;
  expectedRoomVersion: number;
  sourceSha256: string;
  sourceUpdatedAt: string;
  roomName: string;
  documentFilename: string;
  tasks: Array<{ id: string; title: string; complete: boolean }>;
};

/** One existing typed operation; neither a prompt nor a shell command can widen it. */
export function requestedRoomFiling(
  record: AdminActionRecord,
  actor: string,
): ApprovedRoomFiling | undefined {
  const f = record.fields;
  if (
    record.task !== "restricted_filing" ||
    f.destination !== "data_room" ||
    !f.documentId ||
    !f.roomId ||
    !f.displayName ||
    !f.section ||
    !["shared", "internal"].includes(f.visibility ?? "") ||
    Boolean(f.order) === Boolean(f.noOrder) ||
    Boolean(f.taskIds?.length) === Boolean(f.noTask) ||
    (f.completeTaskIds ?? []).some((id) => !f.taskIds?.includes(id))
  )
    return undefined;
  return {
    actor,
    room: f.roomId,
    document: f.documentId,
    displayName: f.displayName,
    section: f.section,
    ...(f.order ? { order: f.order } : {}),
    noOrder: f.noOrder === true,
    visibility: f.visibility as "shared" | "internal",
    acknowledgeRestricted: f.acknowledgeRestricted === true,
    task: [...(f.taskIds ?? [])],
    noTask: f.noTask === true,
    completeTask: [...(f.completeTaskIds ?? [])],
    tag: [...(f.tags ?? [])],
    highlight: f.highlight === true,
  };
}

export function approvedRoomFiling(
  record: AdminActionRecord,
  actor: string,
): ApprovedRoomFiling | undefined {
  return record.preparedFiling ? { ...record.preparedFiling.input, actor } : undefined;
}

type CanonicalPlacement = {
  documentId?: string;
  displayName?: string;
  roomCategory?: string;
  orderKey?: string | null;
  visibility?: string;
  tags?: string[];
  isHighlighted?: boolean;
};

type FilingReceipt = {
  applied?: boolean;
  room?: string;
  actor?: string;
  operation?: string;
  verifiedRoomVersion?: number;
  placement?: CanonicalPlacement;
  verifiedDocument?: CanonicalPlacement;
  verifiedTasks?: Array<{ id: string; documentIds: string[]; status: string }>;
  expectedRoomVersion?: number;
  taskIds?: string[];
  completeTaskIds?: string[];
  preparedTarget?: {
    room: { id: string; name: string };
    document: { id: string; filename: string; sha256: string; sourceUpdatedAt: string };
    tasks: Array<{ id: string; title: string; complete: boolean }>;
  };
};

/** Read-only preparation under the requester's own current administrator grants. */
export async function prepareRoomFiling(
  config: ResolvedPluginConfig,
  record: AdminActionRecord,
  assertCurrent: () => void,
): Promise<PreparedRoomFiling> {
  const identity = record.requester.identity;
  if (identity.channel !== "matrix") throw new Error("Fi conversation preparation is required.");
  const delegation = await lookupDelegation(
    config,
    { requesterMatrixUserId: identity.requesterMatrixUserId },
    { agentId: FI_ADMIN_DELEGATION_AGENT_ID },
  );
  if (
    !delegation ||
    !["admin", "owner"].includes(delegation.user.role) ||
    delegation.user.email !== record.requester.email
  ) {
    throw new Error(
      "This filing needs preparation by a current administrator. It is not executable and no approval card was posted.",
    );
  }
  const input = requestedRoomFiling(record, delegation.user.email);
  if (!input)
    throw new Error(
      "Resolve the exact document, room, placement and checklist targets before requesting approval.",
    );
  assertCurrent();
  const response = await delegatedFetch(
    config,
    delegation,
    `/api/${encodeURIComponent(delegation.user.orgSlug)}/admin-room-filing`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input, dryRun: true }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok)
    throw new Error(
      "The exact filing could not be prepared. Nothing was executed and no approval card was posted.",
    );
  const envelope = (await response.json()) as { ok?: boolean; result?: FilingReceipt };
  assertCurrent();
  const result = envelope.result;
  const plan = result?.placement;
  const target = result?.preparedTarget;
  if (
    envelope.ok !== true ||
    result?.applied !== false ||
    result.operation !== "file" ||
    result.actor !== input.actor ||
    result.room !== input.room ||
    !Number.isSafeInteger(result.expectedRoomVersion) ||
    plan?.documentId !== input.document ||
    plan.displayName !== input.displayName ||
    plan.roomCategory !== input.section ||
    plan.visibility !== input.visibility ||
    plan.isHighlighted !== input.highlight ||
    !Array.isArray(plan.tags) ||
    (input.noOrder ? plan.orderKey !== null : typeof plan.orderKey !== "string") ||
    target?.room?.id !== input.room ||
    !target.room.name ||
    target.document?.id !== input.document ||
    !target.document.filename ||
    typeof target.document.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(target.document.sha256) ||
    typeof target.document.sourceUpdatedAt !== "string" ||
    !Number.isFinite(Date.parse(target.document.sourceUpdatedAt)) ||
    !Array.isArray(target.tasks) ||
    target.tasks.length !== input.task.length ||
    !input.task.every((id) =>
      target.tasks.some(
        (task) =>
          task.id === id &&
          typeof task.title === "string" &&
          task.title.trim() &&
          task.complete === input.completeTask.includes(id),
      ),
    ) ||
    JSON.stringify(result.taskIds) !== JSON.stringify(input.task) ||
    JSON.stringify(result.completeTaskIds) !== JSON.stringify(input.completeTask)
  ) {
    throw new Error(
      "Authoritative filing identities or placement are unresolved. Nothing was executed and no approval card was posted.",
    );
  }
  if (record.fields.roomName && record.fields.roomName !== target.room.name) {
    throw new Error(
      "The requested room name does not match the exact room identifier. Correct it before approval.",
    );
  }
  const { actor: _actor, ...preparedInput } = input;
  return {
    input: {
      ...preparedInput,
      ...(typeof plan.orderKey === "string" ? { order: plan.orderKey } : {}),
      tag: plan.tags,
    },
    expectedRoomVersion: result.expectedRoomVersion!,
    sourceSha256: target.document.sha256,
    sourceUpdatedAt: target.document.sourceUpdatedAt,
    roomName: target.room.name,
    documentFilename: target.document.filename,
    tasks: target.tasks.map((task) => ({
      ...task,
      complete: input.completeTask.includes(task.id),
    })),
  };
}

export function verifiedFilingReceipt(input: ApprovedRoomFiling, receipt: FilingReceipt): boolean {
  const doc = receipt.verifiedDocument;
  const plan = receipt.placement;
  return (
    receipt.applied === true &&
    receipt.operation === "file" &&
    receipt.room === input.room &&
    receipt.actor === input.actor &&
    Number.isSafeInteger(receipt.verifiedRoomVersion) &&
    plan?.documentId === input.document &&
    plan.displayName === input.displayName &&
    plan.roomCategory === input.section &&
    plan.visibility === input.visibility &&
    plan.isHighlighted === input.highlight &&
    plan.orderKey === (input.noOrder ? null : input.order) &&
    JSON.stringify(plan.tags) === JSON.stringify(input.tag) &&
    doc?.documentId === input.document &&
    doc.displayName === input.displayName &&
    doc.roomCategory === input.section &&
    // Preparation already froze the owner's canonical order and tags before
    // approval. Neither replanning nor readback may silently change them now.
    doc.orderKey === plan.orderKey &&
    doc.visibility === input.visibility &&
    doc.isHighlighted === input.highlight &&
    Array.isArray(plan.tags) &&
    JSON.stringify(doc.tags) === JSON.stringify(plan.tags) &&
    Array.isArray(receipt.verifiedTasks) &&
    receipt.verifiedTasks.length === input.task.length &&
    input.task.every((id) =>
      receipt.verifiedTasks?.some(
        (task) =>
          task.id === id &&
          task.documentIds.includes(input.document) &&
          (!input.completeTask.includes(id) || task.status === "resolved"),
      ),
    )
  );
}

/** Call once. An uncertain response is not permission to replay a business write. */
export async function executeApprovedRoomFiling(
  config: ResolvedPluginConfig,
  delegation: Delegation,
  input: ApprovedRoomFiling,
  operationId: string,
  assertCurrent: () => void,
  preparation: Pick<PreparedRoomFiling, "expectedRoomVersion" | "sourceSha256" | "sourceUpdatedAt">,
): Promise<NonNullable<AdminActionRecord["execution"]>> {
  const unknown: NonNullable<AdminActionRecord["execution"]> = {
    state: "unknown",
    operationId,
    message:
      "Approval recorded; filing outcome is unconfirmed. Check the room before attempting another filing.",
  };
  assertCurrent();
  try {
    const response = await delegatedFetch(
      config,
      delegation,
      `/api/${encodeURIComponent(delegation.user.orgSlug)}/admin-room-filing`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: { ...input, preparation }, dryRun: false }),
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!response.ok) return unknown;
    const envelope = (await response.json()) as { ok?: boolean; result?: FilingReceipt };
    if (envelope.ok !== true || !envelope.result || !verifiedFilingReceipt(input, envelope.result))
      return unknown;
    return {
      state: "done",
      operationId,
      message: `Filed ${input.displayName} in the requested room and verified its placement and checklist links.`,
      receipt: {
        roomId: input.room,
        documentId: input.document,
        roomVersion: envelope.result.verifiedRoomVersion!,
        taskIds: input.task,
      },
    };
  } catch {
    return unknown;
  }
}
