import { describe, expect, it } from "vitest";
import { MATRIX_PROJECTION_CONTENT_KEY as key } from "./projection-publication.js";
import type { MatrixRawEvent } from "./sdk.js";
import {
  checkProjectionInvariants,
  noOrphanedUnmarkedOwnEvent,
  noStaleDuplicateWhenConverged,
  noticeRetiredWhenHistoryPresent,
  oneLiveCopyPerPart,
} from "./session-projection-invariants.js";
import type { ProjectionHistory } from "./session-projection-plan.js";

const self = "@transport:example.org";
const messageId = "1700000000.000001";
const notice = "Read-only Slack conversation history. Continue in Slack.";

function marked(revision = 1, part = 0, parts = 1) {
  return {
    body: "**Slack · U111**\nBefore",
    [key]: {
      version: 2,
      origin: { provider: "slack", messageId },
      publicationRevision: revision,
      partIndex: part,
      partCount: parts,
      complete: part === parts - 1,
    },
  };
}

function own(eventId: string, content: Record<string, unknown>): MatrixRawEvent {
  return {
    event_id: eventId,
    sender: self,
    type: "m.room.message",
    origin_server_ts: 0,
    content: { ...content, "m.relates_to": { rel_type: "m.thread", event_id: "$root" } },
  };
}

function history(oldestFirst: MatrixRawEvent[], edits: MatrixRawEvent[] = []): ProjectionHistory {
  return { self, threadId: "$root", events: oldestFirst.toReversed(), edits };
}

describe("projection invariants", () => {
  it("oneLiveCopyPerPart holds for distinct parts and fails on a repeated part", () => {
    expect(
      oneLiveCopyPerPart(history([own("$p0", marked(1, 0, 2)), own("$p1", marked(1, 1, 2))])).ok,
    ).toBe(true);
    expect(oneLiveCopyPerPart(history([own("$old", marked(1)), own("$new", marked(2))]))).toEqual({
      name: "oneLiveCopyPerPart",
      ok: false,
      violations: [{ messageId, eventIds: ["$old", "$new"] }],
    });
  });

  it("noOrphanedUnmarkedOwnEvent accepts a stripped edit on a marked original and flags an unmarked own event", () => {
    const strippedEdit: MatrixRawEvent = {
      event_id: "$edit",
      sender: self,
      type: "m.room.message",
      origin_server_ts: 0,
      content: {
        "m.new_content": { body: "**Slack · U111**\nBefore" },
        "m.relates_to": { rel_type: "m.replace", event_id: "$a" },
      },
    };
    expect(noOrphanedUnmarkedOwnEvent(history([own("$a", marked())], [strippedEdit])).ok).toBe(
      true,
    );
    expect(noOrphanedUnmarkedOwnEvent(history([own("$bare", { body: "Before" })]))).toEqual({
      name: "noOrphanedUnmarkedOwnEvent",
      ok: false,
      violations: [{ eventIds: ["$bare"] }],
    });
  });

  it("noStaleDuplicateWhenConverged ignores torn publications and flags a stale copy beside a complete one", () => {
    // A torn chunked publication is not converged; the reconciler repairs it.
    expect(noStaleDuplicateWhenConverged(history([own("$p0", marked(1, 0, 2))])).ok).toBe(true);
    expect(
      noStaleDuplicateWhenConverged(
        history([own("$old", marked(1, 1, 2)), own("$new", marked(2))]),
      ),
    ).toEqual({
      name: "noStaleDuplicateWhenConverged",
      ok: false,
      violations: [{ messageId, eventIds: ["$old"] }],
    });
  });

  it("noticeRetiredWhenHistoryPresent allows a notice before history and flags one after", () => {
    expect(noticeRetiredWhenHistoryPresent(history([own("$intro", { body: notice })])).ok).toBe(
      true,
    );
    expect(
      noticeRetiredWhenHistoryPresent(
        history([own("$intro", { body: notice }), own("$a", marked())]),
      ),
    ).toEqual({
      name: "noticeRetiredWhenHistoryPresent",
      ok: false,
      violations: [{ eventIds: ["$intro"] }],
    });
  });

  it("reports every invariant by name for a clean thread", () => {
    expect(checkProjectionInvariants(history([own("$a", marked())]))).toEqual([
      { name: "oneLiveCopyPerPart", ok: true, violations: [] },
      { name: "noOrphanedUnmarkedOwnEvent", ok: true, violations: [] },
      { name: "noStaleDuplicateWhenConverged", ok: true, violations: [] },
      { name: "noticeRetiredWhenHistoryPresent", ok: true, violations: [] },
    ]);
  });
});
