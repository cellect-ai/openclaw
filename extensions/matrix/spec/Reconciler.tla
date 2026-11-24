--------------------------- MODULE Reconciler ---------------------------
(***************************************************************************)
(* Model of the OpenClaw session-projection reconciler                     *)
(* (extensions/matrix/src/matrix/session-projection-snapshot.ts).          *)
(*                                                                          *)
(* One "message" = one Slack source message projected into a Matrix room. *)
(* Each message may be published as several parts (chunking) and may be   *)
(* re-published at successive revisions when its source content changes. *)
(* copies[msg] is the set of Matrix events the bot has ever sent for msg, *)
(* mirroring the real per-event fields the reconciler actually reads:     *)
(*   marker    \in {"v2", "v1", "none"}  -- projection metadata on the    *)
(*                                          event's OWN content            *)
(*   editMarker \in {"v2","v1","none","noEdit"} -- projection metadata on *)
(*                                          its latest self-edit, if any  *)
(*   revision, part, parts  -- the v2 publication identity (ignored for   *)
(*                                          v1 / unmarked events)          *)
(*   redacted  \in BOOLEAN                                                 *)
(*   isNoticeBody \in BOOLEAN -- TRUE if the event's current text exactly *)
(*                               equals a binder notice string            *)
(*                                                                          *)
(* This is NOT the real TypeScript -- it is a hand-written abstraction of *)
(* it, so a property that holds here is evidence about the algorithm, not *)
(* a proof that the code matches it line for line.                        *)
(***************************************************************************)
EXTENDS Integers, FiniteSets, Sequences, TLC

CONSTANTS
    Messages,        \* small set of source-message identifiers, e.g. {m1, m2}
    EventIds,        \* pool of fresh Matrix event ids the bot can allocate
    MaxRevision,     \* bound on how many times a message's source content changes
    MaxParts,        \* bound on chunking (1 or 2 is enough to exercise it)
    FIX_RETAINED,    \* TRUE = current code (Sep 22 fix); FALSE = pre-fix bug
    FIX_MARKER_FALLBACK \* TRUE = current code (fallback to original event's
                         \* marker when an edit dropped it); FALSE = pre-fix bug

VARIABLES
    copies,          \* [Messages -> SUBSET Event]  -- all events ever sent, incl. redacted
    sourceRevision,  \* [Messages -> 0..MaxRevision] -- current Slack-side revision
    sourceParts,     \* [Messages -> 1..MaxParts]    -- current part count for that revision
    freeIds,         \* set of EventIds not yet used, so allocation is always distinct
    pendingNotice    \* [Messages -> BOOLEAN] -- TRUE once a binder notice has been
                      \* posted as an unmarked own event for this "room slot"

Marker == {"v2", "v1", "none"}
EditMarker == {"v2", "v1", "none", "noEdit"}

Event == [ id: EventIds, marker: Marker, editMarker: EditMarker,
           revision: 0..MaxRevision, part: 0..(MaxParts-1), parts: 1..MaxParts,
           redacted: BOOLEAN, isNoticeBody: BOOLEAN ]

TypeOK ==
    /\ copies \in [Messages -> SUBSET Event]
    /\ sourceRevision \in [Messages -> 0..MaxRevision]
    /\ sourceParts \in [Messages -> 1..MaxParts]
    /\ freeIds \subseteq EventIds
    /\ pendingNotice \in [Messages -> BOOLEAN]

Init ==
    /\ copies = [m \in Messages |-> {}]
    /\ sourceRevision = [m \in Messages |-> 0]
    /\ sourceParts = [m \in Messages |-> 1]
    /\ freeIds = EventIds
    /\ pendingNotice = [m \in Messages |-> FALSE]

(***************************************************************************)
(* effectiveMarker(e) mirrors projectedSlackMessageId(): read the latest   *)
(* self-edit's marker if the event has one, else the original event's.     *)
(* effectiveMarker(e) mirrors the FIX: it falls back to the original       *)
(* event's own marker when the edit exists but carries no marker of its   *)
(* own (the exact bug fixed in the "keep projection identity on in-place   *)
(* edits" + "recognizes a source message whose earlier edit lost its       *)
(* projection marker" commits).                                            *)
(***************************************************************************)
effectiveMarker(e) ==
    IF e.editMarker = "noEdit" THEN e.marker
    ELSE IF e.editMarker # "none" THEN e.editMarker
    ELSE IF FIX_MARKER_FALLBACK THEN e.marker  \* fixed: fall back to original
         ELSE "none"                            \* pre-fix: marker is lost

hasMarker(e) == effectiveMarker(e) # "none"

\* Live (non-redacted) copies of a message, grouped by the fact they are
\* the SAME source message -- in the real system that grouping key is the
\* Slack messageId; here every event we ever create for `msg` already only
\* exists in copies[msg], so "same message" is implicit in the partition.
liveCopiesOf(m) == { e \in copies[m] : ~e.redacted }

\* currentParts: the live copies whose (v2) revision equals the message's
\* highest live revision -- mirrors `currentParts` in the real code.
highestLiveRevision(m) ==
    IF liveCopiesOf(m) = {} THEN -1
    ELSE CHOOSE r \in { e.revision : e \in liveCopiesOf(m) } :
            \A e \in liveCopiesOf(m) : e.revision <= r

currentPartsOf(m) ==
    LET r == highestLiveRevision(m)
    IN { e \in liveCopiesOf(m) : e.revision = r }

\* "complete": every part 0..parts-1 of the current revision is present
\* exactly once among live copies with a valid marker -- mirrors the
\* `expectedParts`/`indexes` completeness check.
completeAt(m) ==
    LET current == currentPartsOf(m)
        expected == sourceParts[m]
    IN  /\ current # {}
        /\ \A e \in current : e.parts = expected /\ hasMarker(e)
        /\ \A i \in 0..(expected-1) : \E e \in current : e.part = i
        /\ Cardinality({ e.part : e \in current }) = expected  \* no duplicate slot

\* "unchanged": complete at the current revision AND that revision matches
\* the live source revision (mirrors `unchanged` / `sameRevision`).
unchangedAt(m) ==
    /\ completeAt(m)
    /\ highestLiveRevision(m) = sourceRevision[m]

(* Everything ever sent for message m that is NOT part of the winning,     *)
(* now-current set of copies -- this is what the FIXED reconciler redacts. *)

Reconcile(m) ==
    /\ ~unchangedAt(m)                          \* nothing to do if already converged
    /\ LET existing == copies[m]                \* snapshot BEFORE this step
           marked == { e \in existing : ~e.redacted /\ hasMarker(e) }
           \* "editable": earliest still-live marked copy, i.e. currentParts[0]
           \* falling back to existing[0] -- we abstract "earliest" as any
           \* nondeterministic pick among the live marked copies (order is
           \* not semantically meaningful for this property).
       IN
       \/ /\ marked # {}
          /\ \E editable \in marked :
             \E bindingResolves \in BOOLEAN :   \* nondeterministic: publication
                                                  \* capability may or may not
                                                  \* resolve this reconcile
             \E part \in 0..(sourceParts[m]-1) : \* which slot this step fills
             \E freshId \in freeIds :
                LET edited == [ editable EXCEPT !.marker = "v2",
                                                 !.editMarker = "noEdit",
                                                 !.revision = sourceRevision[m],
                                                 !.part = part,
                                                 !.parts = sourceParts[m] ]
                    sentNew == [ id |-> freshId, marker |-> "v2",
                                 editMarker |-> "noEdit",
                                 revision |-> sourceRevision[m],
                                 part |-> part, parts |-> sourceParts[m],
                                 redacted |-> FALSE, isNoticeBody |-> FALSE ]
                    \* keepId mirrors `retainedEventId`. FIXED: it is whichever
                    \* event actually holds the accepted content -- editable's
                    \* id if the edit went through, else the freshly sent
                    \* event's id. PRE-FIX bug (Sep 23 finding): the code set
                    \* `retainedEventId = editable?.eventId` unconditionally,
                    \* even on the branch where a NEW event was sent instead
                    \* because publication could not resolve.
                    keepId == IF FIX_RETAINED
                              THEN IF bindingResolves THEN editable.id ELSE freshId
                              ELSE editable.id
                    \* obsolete ranges only over the PRE-STEP snapshot, exactly
                    \* like the real `existing.filter(id !== retainedEventId)`.
                    obsolete == { e \in existing : e.id # keepId }
                    survivors == { e \in existing : e.id = keepId }
                    survivorsApplied ==
                        { IF e.id = editable.id /\ bindingResolves THEN edited ELSE e
                          : e \in survivors }
                    redactedObsolete == { [e EXCEPT !.redacted = TRUE] : e \in obsolete }
                IN
                /\ copies' = [copies EXCEPT ![m] =
                        survivorsApplied \union redactedObsolete
                        \union (IF bindingResolves THEN {} ELSE {sentNew})]
                /\ freeIds' = freeIds \ {freshId}
                /\ UNCHANGED << sourceRevision, sourceParts, pendingNotice >>
       \/ /\ marked = {}                        \* nothing marked yet: plain send
          /\ \E part \in 0..(sourceParts[m]-1) :
             \E freshId \in freeIds :
                LET newEvent == [ id |-> freshId, marker |-> "v2",
                                   editMarker |-> "noEdit",
                                   revision |-> sourceRevision[m],
                                   part |-> part, parts |-> sourceParts[m],
                                   redacted |-> FALSE, isNoticeBody |-> FALSE ]
                IN
                /\ copies' = [copies EXCEPT ![m] = @ \union {newEvent}]
                /\ freeIds' = freeIds \ {freshId}
                /\ UNCHANGED << sourceRevision, sourceParts, pendingNotice >>

(* Slack-side change: the source content for m is edited, bumping the      *)
(* revision, and Slack may also add/remove a file so the part count        *)
(* changes -- this is the event that makes `unchangedAt` false again.      *)
SourceChanges(m) ==
    /\ sourceRevision[m] < MaxRevision
    /\ \E parts \in 1..MaxParts :
        /\ sourceRevision' = [sourceRevision EXCEPT ![m] = @ + 1]
        /\ sourceParts' = [sourceParts EXCEPT ![m] = parts]
        /\ UNCHANGED << copies, freeIds, pendingNotice >>

(* A same-author IN-PLACE EDIT lands on one live copy, independent of a    *)
(* reconcile pass -- models an edit whose marker did or did not survive,   *)
(* so effectiveMarker() has to exercise both editMarker cases.             *)
SelfEditLosesOrKeepsMarker(m) ==
    /\ \E e \in copies[m] :
        /\ ~e.redacted
        /\ e.editMarker = "noEdit"
        /\ e.marker # "none"      \* an edit only ever lands on an event that was
                                   \* already a genuine source-projected copy;
                                   \* a binding notice (marker = "none") is never
                                   \* re-edited into a projection by this path
        /\ \E keepsMarker \in BOOLEAN :
            copies' = [copies EXCEPT ![m] =
                (@ \ {e}) \union
                {[e EXCEPT !.editMarker = IF keepsMarker THEN "v2" ELSE "none"]}]
    /\ UNCHANGED << sourceRevision, sourceParts, freeIds, pendingNotice >>

(* The bot posts a "session active" / read-only intro notice: an UNMARKED  *)
(* own event whose body exactly equals a binder notice string. Retiring it *)
(* is done by the SAME reconciler pass, via the `notices` branch, which is *)
(* out of scope for this focused model -- we only check it is never        *)
(* confused with, or confuses, a genuine projected message. *)
PostNotice(m) ==
    /\ ~pendingNotice[m]
    /\ \E freshId \in freeIds :
        /\ copies' = [copies EXCEPT ![m] = @ \union
                {[ id |-> freshId, marker |-> "none", editMarker |-> "noEdit",
                   revision |-> 0, part |-> 0, parts |-> 1,
                   redacted |-> FALSE, isNoticeBody |-> TRUE ]}]
        /\ freeIds' = freeIds \ {freshId}
        /\ pendingNotice' = [pendingNotice EXCEPT ![m] = TRUE]
        /\ UNCHANGED << sourceRevision, sourceParts >>

RetireNotice(m) ==
    /\ pendingNotice[m]
    /\ \E e \in copies[m] : ~e.redacted /\ e.isNoticeBody /\ ~hasMarker(e)
        /\ copies' = [copies EXCEPT ![m] =
                (@ \ {e}) \union {[e EXCEPT !.redacted = TRUE]}]
    /\ pendingNotice' = [pendingNotice EXCEPT ![m] = FALSE]
    /\ UNCHANGED << sourceRevision, sourceParts, freeIds >>

Next ==
    \E m \in Messages :
        \/ Reconcile(m)
        \/ SourceChanges(m)
        \/ SelfEditLosesOrKeepsMarker(m)
        \/ PostNotice(m)
        \/ RetireNotice(m)

Spec == Init /\ [][Next]_<<copies, sourceRevision, sourceParts, freeIds, pendingNotice>>

\* Event ids are interchangeable labels -- which concrete id gets used never
\* affects any invariant here -- so TLC can quotient the state space by any
\* permutation of EventIds. Cuts the explored space by roughly |EventIds|!.
EventIdSymmetry == Permutations(EventIds)

----------------------------------------------------------------------------
(* Invariants -- these are the properties Ralph's July-23 fix should       *)
(* satisfy, and which should FAIL when the corresponding FIX_ constant is  *)
(* set to FALSE (reproducing the exact bug that was found and fixed).      *)

\* No more than one live copy per (message, revision, part) slot once the
\* system is not mid-Reconcile (i.e. always true as a state invariant,
\* since Reconcile is atomic here): the core "no stale duplicate" property.
NoDuplicateSlot ==
    \A m \in Messages :
        LET live == { e \in liveCopiesOf(m) : hasMarker(e) }  \* exclude binding
                                                                \* notices, which
                                                                \* are not source
                                                                \* content slots
        IN \A e1, e2 \in live :
            (e1.revision = e2.revision /\ e1.part = e2.part /\ e1 # e2) => FALSE

\* Once converged (unchangedAt), there is exactly `sourceParts[m]` live
\* copies for m and no more -- this is the property the Sep-23
\* "retainedEventId" bug violated: a failed-binding send left the stale
\* `editable` un-redacted alongside the freshly sent event.
NoStaleDuplicateWhenConverged ==
    \A m \in Messages :
        unchangedAt(m) =>
            Cardinality({ e \in liveCopiesOf(m) : hasMarker(e) }) = sourceParts[m]

\* A genuinely marked (v1 or v2) message is NEVER treated as a notice, i.e.
\* RetireNotice only ever targets unmarked events -- already an ASSUME in
\* RetireNotice's guard, but restated as a whole-state invariant: no marked
\* live event has isNoticeBody redacted out from under it for notice reasons.
MarkedNeverRedactedAsNotice ==
    \A m \in Messages :
        \A e \in copies[m] :
            (hasMarker(e) /\ e.isNoticeBody) => ~e.redacted

\* Convergence is stable: reconciling an already-unchanged message is a
\* no-op (mirrors "second republish produces no Matrix events").
Idempotent == \A m \in Messages : unchangedAt(m) => ~ENABLED Reconcile(m)

\* Once converged, every LIVE copy is either a genuine current content slot
\* (marked) or a notice still awaiting its own retirement pass -- nothing
\* else should be live. This is deliberately NOT folded into
\* NoStaleDuplicateWhenConverged's marked-only count: that count is blind
\* to exactly the failure mode this catches -- an event that loses its
\* marker (the pre-fix "marker fallback" bug) becomes invisible to any
\* marked-only tally while remaining live litter in the room forever.
NoOrphanedUnmarkedCopy ==
    \A m \in Messages :
        unchangedAt(m) =>
            \A e \in liveCopiesOf(m) : hasMarker(e) \/ e.isNoticeBody

============================================================================
