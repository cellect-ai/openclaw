// Pure safety checks over a recorded projection thread. Names match the TLA+
// invariants in extensions/matrix/spec/Reconciler.tla where one exists; the
// mapping and the deliberate differences are in extensions/matrix/spec/README.md.
import { MATRIX_PROJECTION_CONTENT_KEY } from "./projection-publication.js";
import {
  analyzeProjectedMessage,
  object,
  readProjectionThread,
  type ProjectionHistory,
} from "./session-projection-plan.js";

export type ProjectionInvariantName =
  | "oneLiveCopyPerPart"
  | "noOrphanedUnmarkedOwnEvent"
  | "noStaleDuplicateWhenConverged"
  | "noticeRetiredWhenHistoryPresent";

export type ProjectionInvariantViolation = { messageId?: string; eventIds: string[] };
export type ProjectionInvariantVerdict = {
  name: ProjectionInvariantName;
  ok: boolean;
  violations: ProjectionInvariantViolation[];
};

function verdict(
  name: ProjectionInvariantName,
  violations: ProjectionInvariantViolation[],
): ProjectionInvariantVerdict {
  return { name, ok: violations.length === 0, violations };
}

function partIndexOf(content: Record<string, unknown>): unknown {
  const publication = object(content[MATRIX_PROJECTION_CONTENT_KEY]);
  // A first-generation (v1) copy is a single-part publication.
  return publication ? publication.partIndex : 0;
}

/**
 * At most one live own copy of each wire part of a source message, across
 * revisions and marker generations. Stricter than the model's NoDuplicateSlot,
 * which keys slots by revision because its reconcile step is atomic; a
 * recorded history between passes must not hold two copies of one part.
 */
export function oneLiveCopyPerPart(history: ProjectionHistory): ProjectionInvariantVerdict {
  const violations: ProjectionInvariantViolation[] = [];
  for (const [messageId, copies] of readProjectionThread(history).messages) {
    const byPart = new Map<unknown, string[]>();
    for (const copy of copies) {
      const index = partIndexOf(copy.content);
      byPart.set(index, [...(byPart.get(index) ?? []), copy.eventId]);
    }
    for (const eventIds of byPart.values()) {
      if (eventIds.length > 1) {
        violations.push({ messageId, eventIds });
      }
    }
  }
  return verdict("oneLiveCopyPerPart", violations);
}

/**
 * Every live own event in the thread is a marked projection or a binding
 * notice. An unmarked copy is invisible to reconciliation and stays forever
 * (the pre-fix marker-fallback bug). Model: NoOrphanedUnmarkedCopy.
 */
export function noOrphanedUnmarkedOwnEvent(history: ProjectionHistory): ProjectionInvariantVerdict {
  const { unmarked } = readProjectionThread(history);
  return verdict(
    "noOrphanedUnmarkedOwnEvent",
    unmarked.map((eventId) => ({ eventIds: [eventId] })),
  );
}

/**
 * A message whose current publication is complete has exactly one live copy
 * per part and nothing else (the pre-fix retained-pointer bug left the old
 * copy beside a fresh send). Model: NoStaleDuplicateWhenConverged.
 */
export function noStaleDuplicateWhenConverged(
  history: ProjectionHistory,
): ProjectionInvariantVerdict {
  const violations: ProjectionInvariantViolation[] = [];
  for (const [messageId, copies] of readProjectionThread(history).messages) {
    const state = analyzeProjectedMessage(copies);
    if (state.complete && copies.length !== state.expectedParts) {
      violations.push({
        messageId,
        eventIds: copies
          .map((copy) => copy.eventId)
          .filter((eventId) => !state.keptIds.has(eventId)),
      });
    }
  }
  return verdict("noStaleDuplicateWhenConverged", violations);
}

/** Once any source message is projected, no own binding notice stays live. */
export function noticeRetiredWhenHistoryPresent(
  history: ProjectionHistory,
): ProjectionInvariantVerdict {
  const thread = readProjectionThread(history);
  return verdict(
    "noticeRetiredWhenHistoryPresent",
    thread.messages.size > 0 ? thread.notices.map((eventId) => ({ eventIds: [eventId] })) : [],
  );
}

export function checkProjectionInvariants(
  history: ProjectionHistory,
): ProjectionInvariantVerdict[] {
  return [
    oneLiveCopyPerPart(history),
    noOrphanedUnmarkedOwnEvent(history),
    noStaleDuplicateWhenConverged(history),
    noticeRetiredWhenHistoryPresent(history),
  ];
}
