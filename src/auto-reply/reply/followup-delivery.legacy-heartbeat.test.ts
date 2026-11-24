import { expect, it } from "vitest";
import { makeCronJob } from "../../cron/delivery.test-helpers.js";
import { TEST_SCHEDULED_OCCURRENCE } from "../../cron/scheduled-occurrence.test-support.js";
import { resolveFollowupDeliveryDecision } from "./followup-delivery.js";
import {
  createAccounting,
  createSettledExecution,
  createTurn,
} from "./followup-delivery.test-helpers.js";

it.each(["missing", "progress", "no_change", "pending", "failed"] as const)(
  "keeps migrated heartbeat followups private except a completed explicit result: %s",
  async (state) => {
    const turn = createTurn();
    turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";
    turn.queued.run.scheduledAutomation = {
      job: { ...makeCronJob({}), legacyHeartbeatReplyPolicy: true },
      occurrence: TEST_SCHEDULED_OCCURRENCE,
      admissionSource: "operator-schedule",
      assertCurrent() {},
    };
    const execution = createSettledExecution("Private final");
    execution.outcome.automation = {
      includeReasoning: true,
      result:
        state === "missing"
          ? undefined
          : state === "no_change"
            ? { outcome: "no_change" }
            : { outcome: "progress", summary: "Explicit result" },
    };
    if (state === "pending") execution.outcome.result.meta.continuationPending = true;
    if (state === "failed") {
      execution.outcome.status = "failed";
      execution.outcome.result.meta.error = { kind: "retry_limit", message: "Synthetic failure" };
    }
    const decision = await resolveFollowupDeliveryDecision({
      turn,
      execution,
      accounting: createAccounting([
        { text: "Private final" },
        { text: "Private reasoning", isReasoning: true },
      ]),
    });
    if (state === "progress") {
      expect(decision).toMatchObject({ kind: "deliver", payloads: [{ text: "Explicit result" }] });
    } else {
      // A host waiting/failure notice may remain; neither execution prose nor an
      // unfinished result is a permitted source reply.
      expect(JSON.stringify(decision)).not.toContain("Private");
      expect(JSON.stringify(decision)).not.toContain("Explicit result");
    }
  },
);
