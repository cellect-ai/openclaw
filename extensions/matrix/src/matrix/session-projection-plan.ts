// Pure half of the source-snapshot reconciler: given everything one pass reads
// from Matrix and the source snapshot, decide every write it would make. The
// I/O half (`reconcileMatrixProjectionSnapshot`) reads, plans and applies.
// Spec and symbol map: extensions/matrix/spec/README.md.
import { createHash } from "node:crypto";
import { isMatrixBindingNoticeText } from "./binding-notice.js";
import { MATRIX_PROJECTION_CONTENT_KEY } from "./projection-publication.js";
import type { MatrixRawEvent } from "./sdk.js";

export const SOURCE_CONTENT_REVISION_KEY = "com.openclaw.source_revision";
// First-generation projections carried only this marker. They are the same
// source message as any later v2 publication and must converge with it.
const LEGACY_SESSION_PROJECTION_KEY = "com.openclaw.session_projection";
// v1 split a long source message into several events sent back to back and
// marked only the first; the unmarked rest followed within this window.
const LEGACY_CHUNK_WINDOW_MS = 5_000;

export type SourceProjectionMessage = {
  messageId: string;
  senderId: string;
  content: string;
  role: "user" | "assistant";
  agentId?: string;
  displayName?: string;
  /** Source timestamp, epoch ms, for providers whose message ids carry none. */
  sourceTs?: number;
};
export type SourceProjectionSnapshot = {
  complete: true;
  messages: SourceProjectionMessage[];
};

/** Everything one reconcile pass reads for a projection thread, nothing it writes. */
export type ProjectionHistory = {
  /** The transport's own Matrix user id. */
  self: string;
  /** Source provider of the room's projection (origin.provider); default "slack". */
  provider?: string;
  /** Projection thread root event id. */
  threadId: string;
  /** m.thread relations of the root, newest first, as read. */
  events: MatrixRawEvent[];
  /** m.replace relations of own thread originals, newest first per original. */
  edits: MatrixRawEvent[];
};

export type ProjectedCopy = {
  eventId: string;
  /** Latest same-author replacement content, else the original content. */
  content: Record<string, unknown>;
  /** The original event's homeserver timestamp. */
  originServerTs?: number;
};

export type ProjectionThread = {
  /** Source message id → own live copies, oldest first. */
  messages: Map<string, ProjectedCopy[]>;
  /** Own live binding notices (intro, "session active"). */
  notices: string[];
  /** Own live events without any projection marker that are not notices. */
  unmarked: string[];
  /**
   * The subset of `unmarked` that are v1 continuation chunks: each directly
   * follows a v1-marked message (or an earlier chunk of it), was sent within
   * seconds of it, and repeats text that message's current body now holds.
   */
  legacyChunks: Array<{ eventId: string; messageId: string }>;
  /** Own non-redacted replacement ids per original, newest first. */
  editIds: Map<string, string[]>;
};

export type ProjectionPart = { partIndex: number; eventId: string };
export type ProjectionRedactReason = "duplicate" | "deleted_in_source" | "rebased_history";
export type ProjectionAction =
  | {
      kind: "unchanged";
      messageId: string;
      revision: number;
      parts: ProjectionPart[];
      /** Retained final wire part, the event the source result is noted against. */
      finalEventId?: string;
    }
  | { kind: "edit"; messageId: string; eventId: string; revision: number }
  | { kind: "send"; messageId: string; revision: number }
  | {
      kind: "redact";
      /** The event redacted: a thread original or one of its replacements. */
      eventId: string;
      /** The thread original this redaction retires. */
      targetEventId: string;
      reason: ProjectionRedactReason;
      messageId?: string;
    }
  | { kind: "retire_notice"; eventId: string; targetEventId: string };

export function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function publicationOf(content: Record<string, unknown>) {
  return object(content[MATRIX_PROJECTION_CONTENT_KEY]);
}

export const DEFAULT_SOURCE_PROVIDER = "slack";

export function historyProvider(history: Pick<ProjectionHistory, "provider">): string {
  return history.provider ?? DEFAULT_SOURCE_PROVIDER;
}

/**
 * Source message id of a current (v2) or first-generation (v1) projection of
 * `provider`. Copies of any other provider are not this room's source.
 */
export function projectedSourceMessageId(
  content: Record<string, unknown>,
  provider: string,
): string | undefined {
  const origin = object(publicationOf(content)?.origin);
  if (origin) {
    return origin.provider === provider && typeof origin.messageId === "string"
      ? origin.messageId
      : undefined;
  }
  const legacy = object(content[LEGACY_SESSION_PROJECTION_KEY]);
  return legacy?.sourceChannel === provider && typeof legacy.messageId === "string"
    ? legacy.messageId
    : undefined;
}

function hasProjectionMarker(content: Record<string, unknown>): boolean {
  return Boolean(publicationOf(content) ?? object(content[LEGACY_SESSION_PROJECTION_KEY]));
}

const normalizedBody = (content: Record<string, unknown>) =>
  typeof content.body === "string" ? content.body.replace(/\s+/g, " ").trim() : "";

/** Own, live, thread-relating messages, oldest first. */
export function projectionThreadOriginals(
  events: MatrixRawEvent[],
  self: string,
  threadId: string,
): MatrixRawEvent[] {
  return events.toReversed().filter((event) => {
    if (
      event.sender !== self ||
      event.unsigned?.redacted_because ||
      event.type !== "m.room.message"
    ) {
      return false;
    }
    const relation = object(object(event.content)?.["m.relates_to"]);
    return relation?.rel_type === "m.thread" && relation.event_id === threadId;
  });
}

/** Groups own thread events by source message, using each one's latest own edit. */
export function readProjectionThread(history: ProjectionHistory): ProjectionThread {
  const provider = historyProvider(history);
  const originals = projectionThreadOriginals(history.events, history.self, history.threadId);
  const originalIds = new Set(originals.map((event) => event.event_id));
  const latest = new Map<string, Record<string, unknown>>();
  const editIds = new Map<string, string[]>();
  // Newest first: the first same-author replacement is authoritative.
  for (const edit of history.edits) {
    if (edit.sender !== history.self || edit.unsigned?.redacted_because) {
      continue;
    }
    const content = object(edit.content);
    const target = object(content?.["m.relates_to"])?.event_id;
    if (typeof target !== "string" || !originalIds.has(target)) {
      continue;
    }
    editIds.set(target, [...(editIds.get(target) ?? []), edit.event_id]);
    const replacement = object(content?.["m.new_content"]);
    if (replacement && !latest.has(target)) {
      latest.set(target, replacement);
    }
  }
  const messages = new Map<string, ProjectedCopy[]>();
  const notices: string[] = [];
  const unmarked: string[] = [];
  const legacyChunks: ProjectionThread["legacyChunks"] = [];
  // The v1-marked message the previous thread event belongs to, if any.
  let chunkAnchor: { messageId: string; sentAt: number; body: string } | undefined;
  for (const event of originals) {
    const original = object(event.content);
    const current = latest.get(event.event_id) ?? original;
    const anchor = chunkAnchor;
    chunkAnchor = undefined;
    if (!current) {
      continue;
    }
    // Earlier in-place edits could drop the projection marker; the original
    // event still identifies the source message, and the next edit restores it.
    const messageId =
      projectedSourceMessageId(current, provider) ??
      projectedSourceMessageId(original ?? {}, provider);
    if (!messageId) {
      if (isMatrixBindingNoticeText(current.body)) {
        notices.push(event.event_id);
      } else if (!hasProjectionMarker(current) && !hasProjectionMarker(original ?? {})) {
        unmarked.push(event.event_id);
        const text = normalizedBody(current);
        if (
          anchor &&
          text &&
          event.origin_server_ts >= anchor.sentAt &&
          event.origin_server_ts - anchor.sentAt <= LEGACY_CHUNK_WINDOW_MS &&
          anchor.body.includes(text)
        ) {
          legacyChunks.push({ eventId: event.event_id, messageId: anchor.messageId });
          chunkAnchor = anchor;
        }
      }
      continue;
    }
    if (original && object(original[LEGACY_SESSION_PROJECTION_KEY])) {
      chunkAnchor = { messageId, sentAt: event.origin_server_ts, body: normalizedBody(current) };
    }
    const group = messages.get(messageId) ?? [];
    group.push({
      eventId: event.event_id,
      content: current,
      originServerTs: event.origin_server_ts,
    });
    messages.set(messageId, group);
  }
  return { messages, notices, unmarked, legacyChunks, editIds };
}

export function sourceMessageContentHash(message: SourceProjectionMessage): string {
  return createHash("sha256").update(JSON.stringify(message)).digest("hex");
}

export function projectionText(params: {
  channel: string;
  role: "user" | "assistant";
  text: string;
  senderId?: string;
  agentId?: string;
  displayName?: string;
}): string {
  const author = params.displayName || params.agentId || params.senderId;
  const speaker = author
    ? author
        .replace(/[\\`*_[\]<>]/g, "")
        .replace(/\s+/g, " ")
        .slice(0, 100)
    : params.role === "user"
      ? "User"
      : "Assistant";
  const source =
    params.channel === "webchat"
      ? "OpenClaw"
      : `${params.channel.slice(0, 1).toUpperCase()}${params.channel.slice(1)}`;
  return `**${source} · ${speaker}**\n${params.text}`;
}

/** The Matrix body a source message is published with. */
export function sourceMessageBody(provider: string, message: SourceProjectionMessage): string {
  return projectionText({
    channel: provider,
    role: message.role,
    text: message.content || "[Message has no text]",
    senderId: message.senderId,
    agentId: message.agentId,
    displayName: message.displayName,
  });
}

/**
 * Publication state of one source message's own copies. With no `contentHash`
 * the source is assumed to still hold the recorded content, which is how a
 * structural (snapshot-free) plan and the invariants read a history.
 */
export function analyzeProjectedMessage(
  existing: ProjectedCopy[],
  contentHash?: string,
  equivalent?: (content: Record<string, unknown>) => boolean,
) {
  const revision = Math.max(
    0,
    ...existing.map((event) => Number(publicationOf(event.content)?.publicationRevision) || 0),
  );
  const currentParts = existing.filter(
    (event) => publicationOf(event.content)?.publicationRevision === revision,
  );
  const expectedParts = Number(publicationOf(currentParts[0]?.content ?? {})?.partCount);
  const sameRevision =
    contentHash === undefined ||
    currentParts.some(
      (event) => object(event.content[SOURCE_CONTENT_REVISION_KEY])?.contentHash === contentHash,
    ) ||
    // The hash covers source fields that never reach the published event
    // (agentId once a display name is set) and a file permalink's viewer
    // segment, which follows whichever account read the thread. A single-part
    // copy that already shows exactly what would be published is current; an
    // edit would change nothing a reader sees yet freeze a projector revision.
    (expectedParts === 1 &&
      equivalent !== undefined &&
      currentParts.length > 0 &&
      currentParts.every((event) => equivalent(event.content)));
  const indexes = new Set(currentParts.map((event) => publicationOf(event.content)?.partIndex));
  const complete =
    sameRevision &&
    Number.isSafeInteger(expectedParts) &&
    expectedParts > 0 &&
    expectedParts <= 256 &&
    indexes.size === expectedParts &&
    Array.from({ length: expectedParts }, (_, index) => index).every((index) =>
      indexes.has(index),
    ) &&
    currentParts.some((event) => publicationOf(event.content)?.complete === true);
  // The earliest copy of each current wire part is kept; any other copy
  // (a repeated slot, an older revision or a legacy v1 mirror) converges.
  const kept = new Map<unknown, string>();
  for (const event of currentParts) {
    const index = publicationOf(event.content)?.partIndex;
    if (!kept.has(index)) {
      kept.set(index, event.eventId);
    }
  }
  const keptIds = new Set(complete ? kept.values() : []);
  // Clients order a thread by Matrix event time. A single-part message
  // whose earliest copy is not current is re-published into that slot;
  // chunked parts cannot be merged into one event and keep their slots.
  const unchanged = complete && (expectedParts > 1 || keptIds.has(existing[0]?.eventId ?? ""));
  return {
    revision,
    expectedParts,
    complete,
    kept,
    keptIds,
    unchanged,
    targetRevision: sameRevision ? revision : revision + 1,
  };
}

// Slack file permalinks embed the reading account's user id
// (`https://<ws>.slack.com/files/<viewer>/<file>/<name>`); the file id names it.
const SLACK_FILE_PERMALINK_VIEWER = /(https:\/\/[^\s/]+\.slack\.com\/files\/)[UW][A-Z0-9]+\//g;

const comparableBody = (body: string) => body.replace(SLACK_FILE_PERMALINK_VIEWER, "$1-/");

/**
 * Whether a copy's current content already shows `message` as `body` would:
 * same rendered text (up to a permalink's viewer segment) and the same author
 * identity, role and name on its publication.
 */
export function publishesSameAs(
  content: Record<string, unknown>,
  message: SourceProjectionMessage,
  body: string,
): boolean {
  const publication = publicationOf(content);
  const origin = object(publication?.origin);
  return (
    typeof content.body === "string" &&
    comparableBody(content.body) === comparableBody(body) &&
    origin?.messageId === message.messageId &&
    origin.actorId === message.senderId &&
    origin.displayName === (message.displayName ? message.displayName.slice(0, 200) : undefined) &&
    publication?.role === message.role &&
    (message.sourceTs === undefined || origin.publishedAtMs === message.sourceTs)
  );
}

function keptParts(kept: Map<unknown, string>): ProjectionPart[] {
  return Array.from(kept, ([partIndex, eventId]) => ({ partIndex: Number(partIndex), eventId }));
}

/**
 * Every write one reconcile pass makes, in the order it makes them.
 * `snapshot` undefined plans structure only: every projected message is taken
 * as current, so duplicates, torn publications and notices show but source
 * edits and deletions cannot. `publishable` is whether the room's binding can
 * issue a trusted publication, which in-place edits require.
 */
export function planProjectionReconcile(
  history: ProjectionHistory,
  snapshot: SourceProjectionSnapshot | undefined,
  options: {
    publishable: boolean;
    retireThreadId?: string;
    /** The body a message would be published with; enables equivalence with it. */
    render?: (message: SourceProjectionMessage) => string;
  },
): ProjectionAction[] {
  const thread = readProjectionThread(history);
  const actions: ProjectionAction[] = [];
  const redact = (targetEventId: string, reason: ProjectionRedactReason, messageId?: string) => {
    for (const eventId of [...(thread.editIds.get(targetEventId) ?? []), targetEventId]) {
      actions.push({
        kind: "redact",
        eventId,
        targetEventId,
        reason,
        ...(messageId ? { messageId } : {}),
      });
    }
  };
  const render = options.render;
  const desired = snapshot
    ? snapshot.messages.map((message) => ({
        messageId: message.messageId,
        contentHash: sourceMessageContentHash(message),
        equivalent: render
          ? (content: Record<string, unknown>) => publishesSameAs(content, message, render(message))
          : undefined,
      }))
    : Array.from(thread.messages.keys(), (messageId) => ({
        messageId,
        contentHash: undefined,
        equivalent: undefined,
      }));
  for (const { messageId, contentHash, equivalent } of desired) {
    const existing = thread.messages.get(messageId) ?? [];
    const state = analyzeProjectedMessage(existing, contentHash, equivalent);
    let retainedEventId: string | undefined;
    if (state.unchanged) {
      actions.push({
        kind: "unchanged",
        messageId,
        revision: state.revision,
        parts: keptParts(state.kept),
        ...(state.kept.has(state.expectedParts - 1)
          ? { finalEventId: state.kept.get(state.expectedParts - 1) }
          : {}),
      });
    } else {
      // Clients order a thread by Matrix event time, not source time. Keep
      // the earliest copy so converged history retains Slack's order. Only an
      // in-place edit keeps the old slot; a fresh send replaces it, so every
      // earlier copy (including the earliest) is obsolete.
      const editable = existing[0];
      if (editable && options.publishable) {
        actions.push({
          kind: "edit",
          messageId,
          eventId: editable.eventId,
          revision: state.targetRevision,
        });
        retainedEventId = editable.eventId;
      } else {
        actions.push({ kind: "send", messageId, revision: state.targetRevision });
      }
    }
    // Retire copies only after the retained event was accepted.
    const obsolete = state.unchanged
      ? existing.filter((event) => !state.keptIds.has(event.eventId))
      : existing.filter((event) => event.eventId !== retainedEventId);
    for (const duplicate of obsolete) {
      redact(duplicate.eventId, "duplicate", messageId);
    }
    // A v1 continuation chunk repeats text the complete message now shows.
    if (state.complete) {
      for (const chunk of thread.legacyChunks) {
        if (chunk.messageId === messageId) {
          redact(chunk.eventId, "duplicate", messageId);
        }
      }
    }
  }
  if (snapshot) {
    const sourceIds = new Set(snapshot.messages.map((message) => message.messageId));
    for (const [messageId, copies] of thread.messages) {
      if (!sourceIds.has(messageId)) {
        for (const copy of copies) {
          redact(copy.eventId, "deleted_in_source", messageId);
        }
      }
    }
  }
  // A source transcript contains source messages only; binder chatter
  // (intro and "session active" notices) is retired once history is present.
  for (const notice of thread.notices) {
    for (const eventId of [...(thread.editIds.get(notice) ?? []), notice]) {
      actions.push({ kind: "retire_notice", eventId, targetEventId: notice });
    }
  }
  // Only after the complete new generation is present may hidden legacy
  // mirrors be retired. Replays retry redaction without duplicating messages.
  const retireThreadId = options.retireThreadId;
  if (retireThreadId && retireThreadId !== history.threadId) {
    for (const event of history.events) {
      if (event.sender !== history.self || event.unsigned?.redacted_because) {
        continue;
      }
      const content = object(event.content);
      const relation = object(content?.["m.relates_to"]);
      const oldSource =
        relation?.rel_type === "m.thread" &&
        relation.event_id === retireThreadId &&
        object(object(content?.[MATRIX_PROJECTION_CONTENT_KEY])?.origin)?.provider ===
          historyProvider(history);
      if (oldSource || event.event_id === retireThreadId) {
        redact(event.event_id, "rebased_history");
      }
    }
  }
  return actions;
}

export type ProjectionMappingPart = ProjectionPart & {
  /** The newest own replacement of this part's event, when it was edited in place. */
  editEventId?: string;
  /** The retained copy's homeserver timestamp. */
  originServerTs?: number;
};

export type ProjectionMappingEntry = {
  messageId: string;
  revision: number;
  partCount: number | null;
  complete: boolean;
  /** The copy the reconciler retains for each current wire part. */
  parts: ProjectionMappingPart[];
  /** Every own live copy of this source message, oldest first. */
  liveEventIds: string[];
  /** Source content hash recorded on the retained copy (hex), when present. */
  contentHash?: string;
  /** origin.publishedAtMs of the retained copy, when present. */
  sourceTs?: number;
};

/** Source content hash recorded on a copy, when it is well formed. */
export function copyContentHash(content: Record<string, unknown>): string | undefined {
  const hash = object(content[SOURCE_CONTENT_REVISION_KEY])?.contentHash;
  return typeof hash === "string" && /^[0-9a-f]{16,128}$/.test(hash) ? hash : undefined;
}

/** publicationRevision and partIndex a copy's current content declares. */
export function copyPublicationSlot(content: Record<string, unknown>) {
  const publication = publicationOf(content);
  const revision = publication?.publicationRevision;
  const partIndex = publication?.partIndex;
  return {
    revision:
      Number.isSafeInteger(revision) && Number(revision) >= 0 ? Number(revision) : undefined,
    partIndex:
      Number.isSafeInteger(partIndex) && Number(partIndex) >= 0 && Number(partIndex) <= 255
        ? Number(partIndex)
        : undefined,
  };
}

/**
 * Source message id → retained event per part, in thread order. This is the
 * one mapping derivation: the plan RPC reports it and the source registry
 * stores it.
 */
export function projectionMapping(history: ProjectionHistory): ProjectionMappingEntry[] {
  const thread = readProjectionThread(history);
  return Array.from(thread.messages, ([messageId, copies]) => {
    const state = analyzeProjectedMessage(copies);
    const byId = new Map(copies.map((copy) => [copy.eventId, copy]));
    const parts = keptParts(state.kept).map(({ partIndex, eventId }) => {
      const part: ProjectionMappingPart = { partIndex, eventId };
      const editEventId = thread.editIds.get(eventId)?.[0];
      const originServerTs = byId.get(eventId)?.originServerTs;
      if (editEventId) {
        part.editEventId = editEventId;
      }
      if (Number.isSafeInteger(originServerTs)) {
        part.originServerTs = originServerTs;
      }
      return part;
    });
    const retained = byId.get(parts[0]?.eventId ?? "")?.content;
    const contentHash = retained ? copyContentHash(retained) : undefined;
    const sourceTs = object(publicationOf(retained ?? {})?.origin)?.publishedAtMs;
    return {
      messageId,
      revision: state.revision,
      partCount: Number.isSafeInteger(state.expectedParts) ? state.expectedParts : null,
      complete: state.complete,
      parts,
      liveEventIds: copies.map((copy) => copy.eventId),
      ...(contentHash ? { contentHash } : {}),
      ...(Number.isSafeInteger(sourceTs) && Number(sourceTs) >= 0
        ? { sourceTs: Number(sourceTs) }
        : {}),
    };
  });
}
