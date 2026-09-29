// Writer for the cellect-threads source registry (projector
// `PUT /v2/sources/rooms/:room_id/mapping`). The registry answers "where does
// source message M live" and keeps an append-only change log. It is never a
// convergence input: markers on Matrix events stay authoritative, and nothing
// here may affect a reconcile. Every failure is logged and swallowed; the room
// is marked dirty and its full mapping is PUT again on its next pass.
import { createHash } from "node:crypto";
import { sourcePublicationAccountId } from "./projection-publication.js";
import { parseProjectionExternalSource } from "./projection-source.js";
import { LogService } from "./sdk/logger.js";
import {
  projectionMapping,
  readProjectionThread,
  copyPublicationSlot,
  type ProjectionHistory,
  type ProjectionMappingEntry,
} from "./session-projection-plan.js";
import { sourceProjectionAdapter } from "./source-projection-adapter.js";

const PUT_TIMEOUT_MS = 3_000;
const MAX_PENDING_ACTIONS = 2_000;
const MAX_MESSAGES = 5_000;
const LOG_MODULE = "source-registry";

// ---------------------------------------------------------------------------
// Idempotency key. One derivation shared with the projector (Rust); the vector
// projector/tests/fixtures/source-idempotency.json pins both sides.

export type SourceKeyFields = {
  provider: string;
  account: string;
  message: string;
  room: string;
  revision?: number | null;
  part?: number | null;
  kind: string;
  target: string;
};

const keyField = (value: string) => value.replaceAll("%", "%25").replaceAll(":", "%3A");

/** `provider:account:msg:room:revision:part:kind:target_event_id`; absent fields are empty. */
export function sourceIdempotencyKey(fields: SourceKeyFields): string {
  const integer = (value: number | null | undefined) =>
    value === null || value === undefined ? "" : String(value);
  return [
    fields.provider,
    fields.account,
    fields.message,
    fields.room,
    integer(fields.revision),
    integer(fields.part),
    fields.kind,
    fields.target,
  ]
    .map(keyField)
    .join(":");
}

// ---------------------------------------------------------------------------
// Body

export type RegistryPart = {
  partIndex: number;
  eventId: string;
  editEventId?: string;
};
export type RegistryMessage = {
  messageId: string;
  revision: number;
  contentHash?: string;
  sourceTs?: number;
  parts: RegistryPart[];
};
export type RegistryActionKind =
  | "publish"
  | "edit"
  | "redact"
  | "retire_notice"
  | "notice"
  | "backfill";
export type RegistryAction = {
  kind: RegistryActionKind;
  messageId?: string;
  revision?: number;
  partIndex?: number;
  /** The event written or removed (the replacement event for an edit). */
  eventId: string;
  /** Edit only: the original the replacement targets. */
  replacesEventId?: string;
  contentHash?: string;
  /** Backfill only: the retained copy's origin_server_ts. */
  originServerTs?: number;
};
export type RegistryRoomIdentity = {
  provider: string;
  /** origin.accountId of the room's projected copies. */
  accountId: string;
  conversationRef: string;
  threadRootEventId?: string;
  /** The Matrix user that publishes the projection (the gateway bot). */
  publisher: string;
};
export type RegistryMappingBody = RegistryRoomIdentity & {
  generation: number;
  orgId: string;
  actor: "gateway" | "backfill";
  archived: boolean;
  messages: RegistryMessage[];
  actions: RegistryAction[];
};

/**
 * The registry identity of a projection room from its binding metadata, or
 * undefined when the binding names no external source with a known adapter.
 */
export function registryRoomIdentity(
  metadata: Record<string, unknown> | undefined,
  accountId: string,
  threadId: string,
  publisher: string,
): RegistryRoomIdentity | undefined {
  const source = parseProjectionExternalSource(metadata?.externalSource);
  const adapter = source ? sourceProjectionAdapter(source.provider) : undefined;
  if (!source || !adapter) {
    return undefined;
  }
  return {
    provider: adapter.provider,
    accountId: sourcePublicationAccountId(metadata, accountId),
    conversationRef: adapter.conversationRef(source),
    threadRootEventId: threadId,
    publisher,
  };
}

/** Mirrors the projector's `protocol::valid_id`. */
function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= 256 &&
    !Array.from(value).some((character) => /\p{Cc}/u.test(character))
  );
}
const validEvent = (value: unknown): value is string => validId(value) && value.startsWith("$");
const validPart = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 255;
const validRevision = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const validHash = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{16,128}$/.test(value);

/** The action's key target: the replaced original for an edit, else the event itself. */
export function registryActionKey(
  identity: Pick<RegistryRoomIdentity, "provider" | "accountId">,
  roomId: string,
  action: RegistryAction,
): string {
  return sourceIdempotencyKey({
    provider: identity.provider,
    account: identity.accountId,
    message: action.messageId ?? "",
    room: roomId,
    revision: action.revision,
    part: action.partIndex,
    kind: action.kind,
    target: action.kind === "edit" ? (action.replacesEventId ?? "") : action.eventId,
  });
}

/**
 * The registry's view of a room: every source message with at least one
 * retained part, from the same `projectionMapping` the plan RPC reports.
 * Parts the projector would refuse (malformed or repeated ids) are left out.
 */
export function registryMessages(mapping: ProjectionMappingEntry[]): RegistryMessage[] {
  const events = new Set<string>();
  const messages: RegistryMessage[] = [];
  for (const entry of mapping) {
    if (!validId(entry.messageId) || !validRevision(entry.revision)) {
      continue;
    }
    const parts: RegistryPart[] = [];
    const indexes = new Set<number>();
    for (const part of entry.parts) {
      if (!validPart(part.partIndex) || indexes.has(part.partIndex)) {
        continue;
      }
      if (!validEvent(part.eventId) || events.has(part.eventId)) {
        continue;
      }
      indexes.add(part.partIndex);
      events.add(part.eventId);
      const edit =
        validEvent(part.editEventId) && !events.has(part.editEventId)
          ? part.editEventId
          : undefined;
      if (edit) {
        events.add(edit);
      }
      parts.push({
        partIndex: part.partIndex,
        eventId: part.eventId,
        ...(edit ? { editEventId: edit } : {}),
      });
    }
    if (parts.length === 0) {
      continue;
    }
    messages.push({
      messageId: entry.messageId,
      revision: entry.revision,
      ...(validHash(entry.contentHash) ? { contentHash: entry.contentHash } : {}),
      ...(Number.isSafeInteger(entry.sourceTs) ? { sourceTs: entry.sourceTs } : {}),
      parts: parts.toSorted((left, right) => left.partIndex - right.partIndex),
    });
    if (messages.length >= MAX_MESSAGES) {
      break;
    }
  }
  return messages;
}

/** One `backfill` row per retained part; no edit history is fabricated. */
export function registryBackfillActions(
  mapping: ProjectionMappingEntry[],
  messages: RegistryMessage[],
): RegistryAction[] {
  const stamps = new Map<string, number | undefined>(
    mapping.flatMap((entry) => entry.parts.map((part) => [part.eventId, part.originServerTs])),
  );
  return messages.flatMap((message) =>
    message.parts.map((part) => {
      const originServerTs = stamps.get(part.eventId);
      return {
        kind: "backfill" as const,
        messageId: message.messageId,
        revision: message.revision,
        partIndex: part.partIndex,
        eventId: part.eventId,
        ...(message.contentHash ? { contentHash: message.contentHash } : {}),
        ...(Number.isSafeInteger(originServerTs) && Number(originServerTs) >= 0
          ? { originServerTs }
          : {}),
      };
    }),
  );
}

/**
 * Revision and part a redaction is keyed by: the redacted copy's current
 * publicationRevision (after any in-place edit) and partIndex, read before the
 * redaction. Absent when the copy carries no current projection marker.
 */
export function redactionSlot(history: ProjectionHistory, targetEventId: string) {
  for (const copies of readProjectionThread(history).messages.values()) {
    const copy = copies.find((candidate) => candidate.eventId === targetEventId);
    if (copy) {
      return copyPublicationSlot(copy.content);
    }
  }
  return { revision: undefined, partIndex: undefined };
}

function validAction(action: RegistryAction, actor: RegistryMappingBody["actor"]): boolean {
  const needsMessage = ["publish", "edit", "backfill"].includes(action.kind);
  return (
    (actor === "backfill") === (action.kind === "backfill") &&
    validEvent(action.eventId) &&
    (action.messageId === undefined || validId(action.messageId)) &&
    (!needsMessage ||
      (action.messageId !== undefined &&
        validRevision(action.revision) &&
        validPart(action.partIndex))) &&
    (action.revision === undefined || validRevision(action.revision)) &&
    (action.partIndex === undefined || validPart(action.partIndex)) &&
    (action.contentHash === undefined || validHash(action.contentHash)) &&
    (action.kind === "edit") === validEvent(action.replacesEventId) &&
    (action.originServerTs === undefined || actor === "backfill")
  );
}

// ---------------------------------------------------------------------------
// Configuration: gateway environment, off unless MATRIX_SOURCE_REGISTRY=write.

export type SourceRegistryConfig = {
  url: string;
  bearer: string;
  orgId: string;
};

let misconfiguredLogged = false;

export function sourceRegistryConfig(
  env: NodeJS.ProcessEnv = process.env,
): SourceRegistryConfig | undefined {
  if (env.MATRIX_SOURCE_REGISTRY?.trim() !== "write") {
    return undefined;
  }
  const url = env.PROJECTOR_REGISTRY_URL?.trim() ?? "";
  const bearer = env.PROJECTOR_REGISTRY_WRITER_BEARER?.trim() ?? "";
  const orgId = env.MATRIX_SOURCE_REGISTRY_ORG?.trim() ?? "";
  if (
    !/^https?:\/\/\S+$/.test(url) ||
    bearer.length < 32 ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(orgId)
  ) {
    if (!misconfiguredLogged) {
      misconfiguredLogged = true;
      LogService.warn(
        LOG_MODULE,
        "registry_misconfigured: MATRIX_SOURCE_REGISTRY=write needs PROJECTOR_REGISTRY_URL, PROJECTOR_REGISTRY_WRITER_BEARER and MATRIX_SOURCE_REGISTRY_ORG",
      );
    }
    return undefined;
  }
  return { url: url.replace(/\/+$/, ""), bearer, orgId };
}

// ---------------------------------------------------------------------------
// Per-room writer state. In memory by design: the full-mapping PUT is
// self-healing, so a restart only costs one extra PUT per room.

type RoomState = {
  dirty: boolean;
  generation?: number;
  /** Applied actions not yet accepted by the registry. */
  pending: RegistryAction[];
  last?: { hash: string; events: Set<string>; edits: Set<string> };
};

const rooms = new Map<string, RoomState>();

export function isSourceRegistryDirty(roomId: string): boolean {
  return rooms.get(roomId)?.dirty === true;
}

export function resetSourceRegistryStateForTest(): void {
  rooms.clear();
  misconfiguredLogged = false;
}

/** Per-room monotonic writer generation: a hybrid clock, never below stored + 1. */
export function nextRegistryGeneration(stored: number | undefined, now = Date.now()): number {
  return Math.max((stored ?? 0) + 1, Math.floor(now));
}

export type RegistrySyncResult =
  | { status: "disabled" | "unchanged" }
  | {
      status: "written" | "replayed";
      generation: number;
      messages: number;
      parts: number;
      logged: number;
      drift: number;
    }
  | {
      status: "failed";
      generation: number;
      httpStatus?: number;
      reason: string;
    };

/**
 * PUTs the room's complete current mapping plus the actions applied since the
 * last accepted PUT. Never throws. A gateway pass whose mapping, pending
 * actions and dirty flag are all unchanged since the last accepted PUT is
 * skipped. Parts or edits that appeared since then without a reconcile action
 * (live publications) are reported as the `publish`/`edit` actions they are.
 */
export async function syncSourceRegistry(params: {
  roomId: string;
  identity: RegistryRoomIdentity;
  history: ProjectionHistory;
  applied?: RegistryAction[];
  actor?: "gateway" | "backfill";
  archived?: boolean;
  storedGeneration?: number;
  persistGeneration?: (generation: number) => void;
  config?: SourceRegistryConfig;
  fetchImpl?: typeof fetch;
}): Promise<RegistrySyncResult> {
  const config = params.config ?? sourceRegistryConfig();
  const actor = params.actor ?? "gateway";
  const state = rooms.get(params.roomId) ?? { dirty: false, pending: [] };
  rooms.set(params.roomId, state);
  if (actor === "gateway" && params.applied?.length) {
    state.pending = [...state.pending, ...params.applied].slice(-MAX_PENDING_ACTIONS);
  }
  if (!config) {
    return { status: "disabled" };
  }
  let generation = state.generation ?? params.storedGeneration ?? 0;
  try {
    const mapping = projectionMapping(params.history);
    const messages = registryMessages(mapping);
    const archived = params.archived === true;
    const hash = createHash("sha256")
      .update(JSON.stringify({ identity: params.identity, archived, messages }))
      .digest("hex");
    const events = new Set(
      messages.flatMap((message) => message.parts.map((part) => part.eventId)),
    );
    const edits = new Set(
      messages.flatMap((message) => message.parts.flatMap((part) => part.editEventId ?? [])),
    );
    let actions: RegistryAction[];
    if (actor === "backfill") {
      actions = registryBackfillActions(mapping, messages);
    } else {
      const explained = new Set(state.pending.map((action) => `${action.kind}\0${action.eventId}`));
      const live: RegistryAction[] = [];
      if (state.last) {
        for (const message of messages) {
          for (const part of message.parts) {
            if (
              !state.last.events.has(part.eventId) &&
              !explained.has(`publish\0${part.eventId}`)
            ) {
              live.push({
                kind: "publish",
                messageId: message.messageId,
                revision: message.revision,
                partIndex: part.partIndex,
                eventId: part.eventId,
                ...(message.contentHash ? { contentHash: message.contentHash } : {}),
              });
            }
            if (
              part.editEventId &&
              !state.last.edits.has(part.editEventId) &&
              !explained.has(`edit\0${part.editEventId}`)
            ) {
              live.push({
                kind: "edit",
                messageId: message.messageId,
                revision: message.revision,
                partIndex: part.partIndex,
                eventId: part.editEventId,
                replacesEventId: part.eventId,
                ...(message.contentHash ? { contentHash: message.contentHash } : {}),
              });
            }
          }
        }
      }
      if (
        !state.dirty &&
        state.pending.length === 0 &&
        live.length === 0 &&
        state.last?.hash === hash
      ) {
        return { status: "unchanged" };
      }
      actions = [...state.pending, ...live];
    }
    const keyed = new Map<string, RegistryAction>();
    for (const action of actions) {
      if (validAction(action, actor)) {
        keyed.set(registryActionKey(params.identity, params.roomId, action), action);
      }
    }
    generation = nextRegistryGeneration(generation);
    state.generation = generation;
    params.persistGeneration?.(generation);
    const body: RegistryMappingBody = {
      generation,
      orgId: config.orgId,
      ...params.identity,
      actor,
      archived,
      messages,
      actions: [...keyed.values()],
    };
    const response = await (params.fetchImpl ?? fetch)(
      `${config.url}/v2/sources/rooms/${encodeURIComponent(params.roomId)}/mapping`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${config.bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
      },
    );
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const reason = typeof payload.error === "string" ? payload.error : `http_${response.status}`;
      return fail(params.roomId, state, generation, reason, response.status);
    }
    state.dirty = false;
    if (actor === "gateway") {
      state.pending = [];
    }
    state.last = { hash, events, edits };
    return {
      status: payload.replayed === true ? "replayed" : "written",
      generation,
      messages: messages.length,
      parts: events.size,
      logged: Number(payload.logged) || 0,
      drift: Number(payload.drift) || 0,
    };
  } catch (error) {
    const reason =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
        ? "timeout"
        : "request_failed";
    return fail(params.roomId, state, generation, reason);
  }
}

function fail(
  roomId: string,
  state: RoomState,
  generation: number,
  reason: string,
  httpStatus?: number,
): RegistrySyncResult {
  state.dirty = true;
  LogService.warn(
    LOG_MODULE,
    `registry_unavailable room=${roomId} reason=${reason}${httpStatus ? ` status=${httpStatus}` : ""} pending=${state.pending.length}`,
  );
  return {
    status: "failed",
    generation,
    reason,
    ...(httpStatus ? { httpStatus } : {}),
  };
}
