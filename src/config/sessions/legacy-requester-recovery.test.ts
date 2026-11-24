import { expect, it } from "vitest";
import { buildChannelSourceTurnId } from "../../auto-reply/reply/source-turn-id.js";
import { inspectLegacyRequesterRecovery } from "./legacy-requester-recovery.js";
import { SessionStoreMigrationRequiredError } from "./migration-required.js";
import { admitCanonicalSessionEntry, parseSqliteSessionEntryRecord } from "./session-entry-json.js";

const sourceId = buildChannelSourceTurnId({
  provider: "matrix",
  accountId: "primary",
  conversationId: "!room:synthetic.test",
  messageId: "$original",
})!;
const requester = {
  restartRecoverySourceIngress: "channel",
  restartRecoveryRequesterSenderId: "@requester:synthetic.test",
  restartRecoveryRequesterAccountId: "primary",
  restartRecoveryRequesterChatId: "!room:synthetic.test",
  restartRecoveryRequesterEventId: "$original",
  restartRecoveryDeliverySourceRunId: sourceId,
  restartRecoveryDeliveryRunId: "old-run",
};

it.each([
  ["admitted reply", { restartRecoveryBeforeAgentReplyState: "admitted" }, "pending-reply"],
  ["waiting reply", { restartRecoveryBeforeAgentReplyState: "pending" }, "pending-reply"],
  ["continuation", { restartRecoveryBeforeAgentReplyState: "continue" }, "pending-reply"],
  ["unknown send", { restartRecoveryDeliveryReceiptState: "terminal-pending" }, "pending-delivery"],
  [
    "retained final",
    { pendingFinalDelivery: { sourceRunId: "old-run", kind: "replayable" } },
    "pending-delivery",
  ],
  [
    "partial final",
    {
      pendingFinalDelivery: {
        sourceRunId: "old-run",
        deliveries: [{ state: "delivered" }, { state: "unknown" }],
      },
    },
    "pending-delivery",
  ],
  [
    "cycle",
    { mainRestartRecovery: { cycleId: "old-cycle", revision: 1, chargedAttempts: 0 } },
    "recovery-cycle",
  ],
  ["malformed cycle", { mainRestartRecovery: "corrupt" }, "recovery-cycle"],
  [
    "abandoned cycle",
    { updatedAt: 1, mainRestartRecovery: { cycleId: "old-cycle" } },
    "recovery-cycle",
  ],
  ["interrupted claim", { status: "interrupted" }, "interrupted-claim"],
  ["current claimant", { status: "running", activeWriterRunId: "old-run" }, "interrupted-claim"],
] as const)(
  "preserves raw %s instead of manufacturing native requester authority",
  (_name, fields, reason) => {
    const entry = { sessionId: "original", updatedAt: 42, ...requester, ...fields };
    const raw = JSON.stringify(entry);
    const decoded = parseSqliteSessionEntryRecord({ entry_json: raw });
    expect(decoded).toEqual(entry);
    expect(inspectLegacyRequesterRecovery(decoded!)).toMatchObject({ reason });
    expect(() => admitCanonicalSessionEntry(decoded!)).toThrow(SessionStoreMigrationRequiredError);
    // The precheck is pure: raw storage and all correlation/terminal facts survive refusal.
    expect(JSON.stringify(decoded)).toBe(raw);
    expect(decoded).not.toHaveProperty("resumeAfterRestart");
    expect(decoded).not.toHaveProperty("queuedInputSources");
  },
);

it.each([
  [
    "attribution only",
    { restartRecoveryRequesterSenderId: requester.restartRecoveryRequesterSenderId },
  ],
  [
    "terminal source",
    { ...requester, status: "interrupted", restartRecoveryTerminalRunIds: [sourceId] },
  ],
  [
    "settled outbound",
    {
      ...requester,
      status: "completed",
      restartRecoveryDeliveryReceiptState: "delivered-terminal",
    },
  ],
  [
    "settled final",
    {
      ...requester,
      pendingFinalDelivery: {
        sourceRunId: "old-run",
        deliveries: [{ state: "delivered" }, { state: "suppressed" }],
      },
    },
  ],
  [
    "successor owner",
    { ...requester, status: "running", activeWriterRunId: "new-run", lifecycleRunId: "new-run" },
  ],
  [
    "successor final",
    { ...requester, pendingFinalDelivery: { sourceRunId: "new-run", kind: "replayable" } },
  ],
  [
    "explicit tombstone",
    {
      ...requester,
      mainRestartRecovery: { cycleId: "old-cycle", tombstone: { reason: "authority unavailable" } },
    },
  ],
  ["native recovery", { resumeAfterRestart: { queuedInputIds: ["native-accepted-input"] } }],
] as const)("does not veto %s merely because historical identity fields exist", (_name, fields) => {
  expect(
    inspectLegacyRequesterRecovery({ sessionId: "same", updatedAt: 42, ...fields }),
  ).toBeUndefined();
});

it.each(["exact", "missing event", "wrong event", "wrong sender", "malformed sender"] as const)(
  "does not upgrade %s historical attribution into a retained authenticated source",
  (variant) => {
    const entry = {
      ...requester,
      mainRestartRecovery: { cycleId: "old-cycle" },
      ...(variant === "missing event" ? { restartRecoveryRequesterEventId: undefined } : {}),
      ...(variant === "wrong event" ? { restartRecoveryRequesterEventId: "$other" } : {}),
      ...(variant === "wrong sender"
        ? { restartRecoveryRequesterSenderId: "@other:synthetic.test" }
        : {}),
      ...(variant === "malformed sender"
        ? { restartRecoveryRequesterSenderId: { profileId: "operator" } }
        : {}),
    };
    expect(inspectLegacyRequesterRecovery(entry)?.reason).toBe("recovery-cycle");
    // Current profile/owner fields cannot backfill an absent historical authorization ceiling.
    expect(
      inspectLegacyRequesterRecovery({
        ...entry,
        createdActor: { type: "human", source: "profile", id: "current-admin" },
      })?.reason,
    ).toBe("recovery-cycle");
  },
);
