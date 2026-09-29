# Reconciler model (TLA+)

`Reconciler.tla` models the source-snapshot reconciler in
`src/matrix/session-projection-snapshot.ts` (I/O) and
`src/matrix/session-projection-plan.ts` (pure planner). It abstracts
pagination, Tuwunel's missing edit bundling, concurrent Slack edits and network
failure, so it checks the algorithm, not the TypeScript. Re-run TLC whenever
`planProjectionReconcile` or `applyProjectionPlan` changes.

The source registry (`src/matrix/source-registry.ts`) is outside the model on
purpose: it is never a planning input, `applyProjectionPlan` only reports the
writes it made to it, and a registry failure cannot change a pass's writes.
If the registry ever becomes a convergence input, the model must gain it first.

## Symbol map

| TLA+                                          | TypeScript                                                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `copies[m]`                                   | `readProjectionThread(history).messages.get(messageId)`                                                                      |
| `effectiveMarker(e)`, `hasMarker(e)`          | `projectedSourceMessageId(current) ?? projectedSourceMessageId(original)` in `readProjectionThread`                          |
| `FIX_MARKER_FALLBACK`                         | the `?? projectedSourceMessageId(original)` fallback                                                                         |
| `currentPartsOf`, `completeAt`, `unchangedAt` | `analyzeProjectedMessage` (`currentParts`, `complete`, `unchanged`)                                                          |
| `Reconcile(m)`                                | one message of `planProjectionReconcile` (`edit` / `send` + `redact` reason `duplicate`), performed by `applyProjectionPlan` |
| `bindingResolves`                             | `options.publishable` (`bindingPublishes` in the snapshot module)                                                            |
| `keepId`                                      | `retainedEventId` in `planProjectionReconcile`: the edited copy, or none when a fresh `send` replaces every copy             |
| `FIX_RETAINED`                                | the send branch leaving `retainedEventId` undefined                                                                          |
| `SourceChanges(m)`                            | a snapshot message whose `sourceMessageContentHash` differs from the recorded `com.openclaw.source_revision`                 |
| `SelfEditLosesOrKeepsMarker(m)`               | `m.replace` edits in `ProjectionHistory.edits`, read by `readSelfEdits`                                                      |
| `PostNotice(m)`                               | binder notices, sent outside the reconciler                                                                                  |
| `RetireNotice(m)`                             | `retire_notice` actions                                                                                                      |

| TLA+ invariant                  | E-1 check (`src/matrix/session-projection-invariants.ts`)                                                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NoDuplicateSlot`               | `oneLiveCopyPerPart`, which is stricter: it keys by part only, not (revision, part), because a recorded history between passes must not hold two copies of one part in any revision |
| `NoStaleDuplicateWhenConverged` | `noStaleDuplicateWhenConverged`                                                                                                                                                     |
| `NoOrphanedUnmarkedCopy`        | `noOrphanedUnmarkedOwnEvent`                                                                                                                                                        |
| `MarkedNeverRedactedAsNotice`   | no runtime check; `readProjectionThread` only classifies events without a source message id as notices                                                                              |
| —                               | `noticeRetiredWhenHistoryPresent` (TypeScript only; the model has `RetireNotice` as an action, not a state property)                                                                |

`session-projection-plan.test.ts` replays the fixed bugs against `plan()`
with recorded histories.

## Running TLC

TLC needs Java 17 and `tla2tools.jar` from the
[TLA+ tools releases](https://github.com/tlaplus/tlaplus/releases) (the
recorded results used TLC 2.19). Deadlock checking must be off (`-deadlock`),
because the model stops once its pool of event ids runs out. Keep TLC's state
directory out of the repository with `-metadir`, as it can grow very large.

```bash
cd extensions/matrix/spec
java -XX:+UseParallelGC -cp /path/to/tla2tools.jar tlc2.TLC \
  -deadlock -workers 8 -metadir /tmp/tlc-reconciler \
  -config fixed-single.cfg Reconciler.tla
rm -rf /tmp/tlc-reconciler
```

## Configurations

| Config             | Fixes                                | Expected result                                                                                                                                            |
| ------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixed-single.cfg` | both on                              | No error. One message, 2 revisions, 2 parts: 327,251 distinct states, exhaustively clean in about a minute                                                 |
| `bug-retained.cfg` | `FIX_RETAINED = FALSE`               | `NoStaleDuplicateWhenConverged` violated: an unbound send left the old copy live                                                                           |
| `bug-marker.cfg`   | `FIX_MARKER_FALLBACK = FALSE`        | `NoOrphanedUnmarkedCopy` violated: an edit that dropped the marker orphaned its copy                                                                       |
| `probe.cfg`        | `FIX_RETAINED = FALSE`, smaller pool | `NoStaleDuplicateWhenConverged` violated; a fast check that the bug is still reachable                                                                     |
| `fixed-two.cfg`    | both on                              | Two messages. Not proven: it had not finished after about 3 hours (about 740,000 distinct states). The production sweep covers multi-message interleavings |
