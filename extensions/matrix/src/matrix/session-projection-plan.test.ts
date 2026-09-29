import { describe, expect, it } from "vitest";
import { MATRIX_PROJECTION_CONTENT_KEY as key } from "./projection-publication.js";
import type { MatrixRawEvent } from "./sdk.js";
import {
  planProjectionReconcile,
  projectionMapping,
  SOURCE_CONTENT_REVISION_KEY,
  sourceMessageContentHash,
  type ProjectionHistory,
  type SourceProjectionMessage,
} from "./session-projection-plan.js";

// Recorded histories are written the way Tuwunel returns them: thread events
// and edits newest first, edits only through their own m.replace read.
const self = "@transport:example.org";
const thread = { "m.relates_to": { rel_type: "m.thread", event_id: "$root" } };
const before: SourceProjectionMessage = {
  messageId: "1700000000.000001",
  senderId: "U111",
  role: "user",
  content: "Before",
};
const after: SourceProjectionMessage = { ...before, content: "After" };
const snapshotOf = (...messages: SourceProjectionMessage[]) =>
  ({ complete: true, messages }) as const;

function marker(
  message: SourceProjectionMessage,
  options: {
    revision?: number;
    part?: number;
    parts?: number;
    hashOf?: SourceProjectionMessage;
  } = {},
) {
  const { revision = 1, part = 0, parts = 1, hashOf = message } = options;
  return {
    body: `**Slack · U111**\n${hashOf.content}`,
    [SOURCE_CONTENT_REVISION_KEY]: { contentHash: sourceMessageContentHash(hashOf) },
    [key]: {
      version: 2,
      origin: { provider: "slack", messageId: message.messageId },
      publicationRevision: revision,
      partIndex: part,
      partCount: parts,
      complete: part === parts - 1,
    },
  };
}

function own(eventId: string, content: Record<string, unknown>, sender = self): MatrixRawEvent {
  return {
    event_id: eventId,
    sender,
    type: "m.room.message",
    origin_server_ts: 0,
    content: { ...content, ...thread },
  };
}

function edit(
  eventId: string,
  target: string,
  replacement: Record<string, unknown>,
): MatrixRawEvent {
  return {
    event_id: eventId,
    sender: self,
    type: "m.room.message",
    origin_server_ts: 0,
    content: {
      body: `* ${String(replacement.body)}`,
      "m.new_content": replacement,
      "m.relates_to": { rel_type: "m.replace", event_id: target },
    },
  };
}

/** `oldestFirst` thread events, `edits` newest first. */
function history(oldestFirst: MatrixRawEvent[], edits: MatrixRawEvent[] = []): ProjectionHistory {
  return { self, threadId: "$root", events: oldestFirst.toReversed(), edits };
}

const bound = { publishable: true };

describe("planProjectionReconcile", () => {
  it("plans nothing but unchanged for a converged thread, with or without a snapshot", () => {
    const recorded = history([own("$a", marker(before))]);
    const expected = [
      {
        kind: "unchanged",
        messageId: before.messageId,
        revision: 1,
        parts: [{ partIndex: 0, eventId: "$a" }],
        finalEventId: "$a",
      },
    ];
    expect(planProjectionReconcile(recorded, snapshotOf(before), bound)).toEqual(expected);
    expect(planProjectionReconcile(recorded, undefined, bound)).toEqual(expected);
  });

  it("redacts exactly the later copy of a seeded duplicate", () => {
    const recorded = history([own("$a", marker(before)), own("$dup", marker(before))]);
    const actions = planProjectionReconcile(recorded, undefined, bound);
    expect(actions.filter((action) => action.kind !== "unchanged")).toEqual([
      {
        kind: "redact",
        eventId: "$dup",
        targetEventId: "$dup",
        reason: "duplicate",
        messageId: before.messageId,
      },
    ]);
  });

  it("compares against the latest own edit, not the stale original (stale-edit bug)", () => {
    const recorded = history(
      [own("$a", marker(before))],
      [edit("$e1", "$a", marker(before, { revision: 2, hashOf: after }))],
    );
    expect(planProjectionReconcile(recorded, snapshotOf(after), bound)).toEqual([
      expect.objectContaining({ kind: "unchanged", revision: 2, finalEventId: "$a" }),
    ]);
    // Without the m.replace read the same room re-edits on every pass.
    const unread = { ...recorded, edits: [] };
    expect(planProjectionReconcile(unread, snapshotOf(after), bound)).toEqual([
      { kind: "edit", messageId: before.messageId, eventId: "$a", revision: 2 },
    ]);
  });

  it("keeps a copy whose latest edit lost its marker and repairs it in place (stripped-marker bug)", () => {
    const recorded = history(
      [own("$a", marker(before))],
      [edit("$e1", "$a", { body: "**Slack · Actor**\nBefore" })],
    );
    expect(planProjectionReconcile(recorded, snapshotOf(before), bound)).toEqual([
      { kind: "edit", messageId: before.messageId, eventId: "$a", revision: 1 },
    ]);
  });

  it("retires the old copy when an unbound pass must send (retained-copy pointer bug)", () => {
    const recorded = history([own("$a", marker(before))]);
    expect(planProjectionReconcile(recorded, snapshotOf(after), { publishable: false })).toEqual([
      { kind: "send", messageId: before.messageId, revision: 2 },
      {
        kind: "redact",
        eventId: "$a",
        targetEventId: "$a",
        reason: "duplicate",
        messageId: before.messageId,
      },
    ]);
  });

  it("groups a legacy v1 mirror with its v2 copies and keeps the earliest (v1 grouping bug)", () => {
    const legacy = own("$legacy", {
      body: "**Slack · U111**\nBefore",
      "com.openclaw.session_projection": {
        version: 1,
        sourceChannel: "slack",
        messageId: before.messageId,
        senderId: "U111",
        role: "user",
      },
    });
    const recorded = history([
      legacy,
      own("$v1", { ...marker(before, { revision: 1 }), [SOURCE_CONTENT_REVISION_KEY]: undefined }),
      own("$v2", { ...marker(before, { revision: 2 }), [SOURCE_CONTENT_REVISION_KEY]: undefined }),
    ]);
    const actions = planProjectionReconcile(recorded, snapshotOf(before), bound);
    expect(actions[0]).toEqual({
      kind: "edit",
      messageId: before.messageId,
      eventId: "$legacy",
      revision: 3,
    });
    expect(actions.slice(1).map((action) => action.kind === "redact" && action.eventId)).toEqual([
      "$v1",
      "$v2",
    ]);
  });

  it("retires own binding notices, edits first, and never a marked or foreign event", () => {
    const recorded = history(
      [
        own("$intro", { body: "Read-only Slack conversation history. Continue in Slack." }),
        own("$a", marker(before)),
        own(
          "$foreign",
          { body: "Read-only Slack conversation history. Continue in Slack." },
          "@h:x",
        ),
      ],
      [edit("$e1", "$intro", { body: "Read-only Slack conversation history. Continue in Slack." })],
    );
    expect(
      planProjectionReconcile(recorded, snapshotOf(before), bound).filter(
        (action) => action.kind !== "unchanged",
      ),
    ).toEqual([
      { kind: "retire_notice", eventId: "$e1", targetEventId: "$intro" },
      { kind: "retire_notice", eventId: "$intro", targetEventId: "$intro" },
    ]);
  });

  it("redacts source deletions with their edits only when a snapshot says so", () => {
    const recorded = history(
      [own("$a", marker(before))],
      [edit("$e1", "$a", marker(before, { revision: 1 }))],
    );
    expect(planProjectionReconcile(recorded, snapshotOf(), bound)).toEqual([
      expect.objectContaining({ kind: "redact", eventId: "$e1", reason: "deleted_in_source" }),
      expect.objectContaining({ kind: "redact", eventId: "$a", reason: "deleted_in_source" }),
    ]);
    expect(planProjectionReconcile(recorded, undefined, bound)).toEqual([
      expect.objectContaining({ kind: "unchanged" }),
    ]);
  });

  it("retires the previous generation's root and source copies on a rebase", () => {
    const old = {
      ...own("$old", marker(before)),
      content: {
        ...marker(before),
        "m.relates_to": { rel_type: "m.thread", event_id: "$previous" },
      },
    };
    const recorded = history([own("$a", marker(before)), old]);
    expect(
      planProjectionReconcile(recorded, snapshotOf(before), {
        publishable: true,
        retireThreadId: "$previous",
      }).filter((action) => action.kind === "redact"),
    ).toEqual([
      { kind: "redact", eventId: "$old", targetEventId: "$old", reason: "rebased_history" },
    ]);
  });
});

describe("v1 continuation chunks", () => {
  // v1 split a long Slack message into back-to-back events and marked only
  // the first; the reconciler later edited that first event into the complete
  // v2 message (822c218d, e58e5130, f1ce6c6b).
  const long: SourceProjectionMessage = {
    ...before,
    messageId: "1789139245.285579",
    content: "First part of a long answer. Second part follows. Third part ends it.",
  };
  const sentAt = 1_789_139_246_000;
  const at = (event: MatrixRawEvent, ts: number) => ({ ...event, origin_server_ts: ts });
  const v1First = at(
    own("$first", {
      body: "**Slack · U111**\nFirst part of a long answer.",
      "com.openclaw.session_projection": {
        version: 1,
        sourceChannel: "slack",
        messageId: long.messageId,
        senderId: "U111",
        role: "user",
      },
    }),
    sentAt,
  );
  const completed = [edit("$complete", "$first", marker(long))];
  const chunk = (eventId: string, body: string, ts = sentAt) => at(own(eventId, { body }), ts);
  const redactions = (actions: ReturnType<typeof planProjectionReconcile>) =>
    actions.flatMap((action) =>
      action.kind === "redact" ? [[action.eventId, action.reason, action.messageId]] : [],
    );

  it("redacts unmarked chunks that repeat the completed v1 message, after it is kept", () => {
    const recorded = history(
      [
        v1First,
        chunk("$chunk1", "Second part follows."),
        chunk("$chunk2", "Third part\nends it.", sentAt + 1_200),
      ],
      completed,
    );
    for (const snapshot of [undefined, snapshotOf(long)]) {
      const actions = planProjectionReconcile(recorded, snapshot, bound);
      expect(actions[0]).toMatchObject({ kind: "unchanged", messageId: long.messageId });
      expect(redactions(actions)).toEqual([
        ["$chunk1", "duplicate", long.messageId],
        ["$chunk2", "duplicate", long.messageId],
      ]);
    }
  });

  it("never redacts an unmarked event that fails any chunk check", () => {
    const unrelated = history([v1First, chunk("$reply", "Here is a different answer.")], completed);
    const late = history(
      [v1First, chunk("$late", "Second part follows.", sentAt + 60_000)],
      completed,
    );
    const early = history(
      [v1First, chunk("$early", "Second part follows.", sentAt - 1)],
      completed,
    );
    const notAdjacent = history(
      [v1First, own("$other", marker(after)), chunk("$apart", "Second part follows.")],
      completed,
    );
    const v2Only = history([
      at(own("$v2", marker(long)), sentAt),
      chunk("$afterV2", "Second part follows."),
    ]);
    const empty = history([v1First, chunk("$blank", "  ")], completed);
    for (const recorded of [unrelated, late, early, notAdjacent, v2Only, empty]) {
      expect(redactions(planProjectionReconcile(recorded, undefined, bound))).toEqual([]);
    }
  });

  it("waits until the v1 message is complete before redacting a chunk", () => {
    // Unedited, the first chunk alone does not hold the continuation's text.
    const recorded = history([v1First, chunk("$chunk1", "Second part follows.")]);
    const actions = planProjectionReconcile(recorded, snapshotOf(long), bound);
    expect(actions[0]).toMatchObject({ kind: "edit", eventId: "$first" });
    expect(redactions(actions)).toEqual([]);
  });
});

describe("projectionMapping", () => {
  it("maps each source message to its retained copy per part", () => {
    const second: SourceProjectionMessage = { ...before, messageId: "1700000000.000002" };
    const recorded = history([
      own("$p0", marker(before, { parts: 2 })),
      own("$p1", marker(before, { part: 1, parts: 2 })),
      own("$p0dup", marker(before, { parts: 2 })),
      own("$b", marker(second)),
    ]);
    expect(projectionMapping(recorded)).toEqual([
      {
        messageId: before.messageId,
        revision: 1,
        partCount: 2,
        complete: true,
        parts: [
          { partIndex: 0, eventId: "$p0", originServerTs: 0 },
          { partIndex: 1, eventId: "$p1", originServerTs: 0 },
        ],
        liveEventIds: ["$p0", "$p1", "$p0dup"],
        contentHash: sourceMessageContentHash(before),
      },
      {
        messageId: second.messageId,
        revision: 1,
        partCount: 1,
        complete: true,
        parts: [{ partIndex: 0, eventId: "$b", originServerTs: 0 }],
        liveEventIds: ["$b"],
        contentHash: sourceMessageContentHash(second),
      },
    ]);
  });

  it("reports a part's newest own edit and the edited content's hash", () => {
    const recorded = history(
      [own("$a", marker(before))],
      [
        edit("$e2", "$a", marker(after, { revision: 2 })),
        edit("$e1", "$a", marker(before, { revision: 1 })),
      ],
    );
    expect(projectionMapping(recorded)).toMatchObject([
      {
        messageId: before.messageId,
        revision: 2,
        parts: [{ partIndex: 0, eventId: "$a", editEventId: "$e2" }],
        contentHash: sourceMessageContentHash(after),
      },
    ]);
  });

  it("reads only copies of the history's own provider", () => {
    const foreign = marker(before);
    (foreign[key] as { origin: { provider: string } }).origin.provider = "email";
    const recorded = { ...history([own("$a", foreign)]), provider: "email" };
    expect(projectionMapping(recorded).map((entry) => entry.messageId)).toEqual([before.messageId]);
    expect(projectionMapping(history([own("$a", foreign)]))).toEqual([]);
  });
});
