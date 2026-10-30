import { afterAll, describe, expect, it } from "vitest";
import { buildChannelSourceTurnId } from "../../auto-reply/reply/source-turn-id.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { buildPersistedUserTurnMessage } from "../../sessions/user-turn-transcript.message.js";
import {
  createSqliteTranscriptTarget,
  persistUserTurnTranscript,
} from "../../sessions/user-turn-transcript.test-support.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  prepareRestartRecoveryRequesterEntry,
  restoreRestartRecoveryRequesterEvent,
} from "./agent-restart-recovery-requester.js";

const CHANNEL = "matrix";
const ROOM = "!original:matrix.example";
const SENDER = "@requester:matrix.example";
const ACCOUNT = "adminprod";
const EVENT = "$original";
const SOURCE = buildChannelSourceTurnId({
  provider: CHANNEL,
  accountId: ACCOUNT,
  conversationId: `room:${ROOM}`,
  messageId: EVENT,
})!;
// These fields already existed in resident03ed. No newly added requester event fields.
const oldClaim = {
  sessionId: "original-session",
  updatedAt: 1,
  restartRecoveryDeliveryRunId: "native-recovery",
  restartRecoveryDeliverySourceRunId: SOURCE,
  restartRecoveryDeliveryContext: { channel: CHANNEL, to: `room:${ROOM}`, accountId: ACCOUNT },
  restartRecoverySourceIngress: "channel" as const,
  restartRecoveryRequesterAccountId: ACCOUNT,
  restartRecoveryRequesterSenderId: SENDER,
};
const originalInput = {
  text: "Continue this original task",
  idempotencyKey: SOURCE,
  sender: { id: SENDER },
  transport: { channel: CHANNEL, messageId: EVENT, conversationRef: "conv_opaque_original" },
};
const originalEvent = { message: buildPersistedUserTurnMessage(originalInput) };

describe("resident-source requester recovery", () => {
  const dirs = useSessionStoreTempDirs(afterAll, "openclaw-requester-upgrade-");

  it("reads the resident-shaped original event through the worker and restores its exact claim", async () => {
    const sessionKey = "agent:main:matrix:channel:!original:matrix.example";
    const target = createSqliteTranscriptTarget({
      dir: dirs.make(),
      sessionKey,
      sessionId: oldClaim.sessionId,
    });
    await replaceSessionEntry(target, oldClaim);
    await persistUserTurnTranscript({ ...target, input: originalInput, updateMode: "none" });
    const entry = await prepareRestartRecoveryRequesterEntry({
      agentId: "main",
      sessionKey,
      storePath: target.storePath,
      isRestartRecoveryResumeRun: true,
      canUseInternalRuntimeHandoff: true,
      expectedExistingSessionId: oldClaim.sessionId,
      resolvedSessionId: oldClaim.sessionId,
      runId: oldClaim.restartRecoveryDeliveryRunId,
      sessionEntry: oldClaim,
      assertCurrent: () => {},
    });
    expect(entry).toMatchObject({
      restartRecoveryRequesterChatId: ROOM,
      restartRecoveryRequesterEventId: EVENT,
    });
    expect(oldClaim).not.toHaveProperty("restartRecoveryRequesterEventId");
  });

  it.each([
    "missing original",
    "different sender",
    "different account",
    "different target",
    "internal input",
    "duplicate source",
  ])("refuses %s", (kind) => {
    const entry =
      kind === "different account"
        ? { ...oldClaim, restartRecoveryRequesterAccountId: "other" }
        : kind === "different target"
          ? {
              ...oldClaim,
              restartRecoveryDeliveryContext: {
                ...oldClaim.restartRecoveryDeliveryContext,
                to: "!other:matrix.example",
              },
            }
          : oldClaim;
    const events =
      kind === "missing original"
        ? []
        : kind === "duplicate source"
          ? [originalEvent, originalEvent]
          : kind === "different sender"
            ? [
                {
                  message: buildPersistedUserTurnMessage({
                    ...originalInput,
                    sender: { id: "@other:matrix.example" },
                  }),
                },
              ]
            : kind === "internal input"
              ? [
                  {
                    message: buildPersistedUserTurnMessage({
                      ...originalInput,
                      provenance: { kind: "internal_system", sourceTool: "operator" },
                    }),
                  },
                ]
              : [originalEvent];
    expect(restoreRestartRecoveryRequesterEvent(entry, events)).toBe(entry);
  });
});
