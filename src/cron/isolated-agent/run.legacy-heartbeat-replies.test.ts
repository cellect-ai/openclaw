import { describe, expect, it } from "vitest";
import { createAutomationResultRecorder } from "../../infra/agent-run-registry.automation.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import * as h from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await h.loadRunCronIsolatedAgentTurn();

describe("migrated heartbeat native isolated delivery", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it.each([
    { marked: true, result: "missing", quiet: true },
    { marked: true, result: "no_change", quiet: true },
    { marked: true, result: "progress", quiet: false },
    { marked: true, result: "progress", pending: true, quiet: true },
    { marked: true, result: "progress", failed: true, quiet: true },
    { marked: false, result: "missing", quiet: false },
    { marked: true, result: "missing", automatic: true, quiet: false },
    { marked: true, result: "missing", group: true, quiet: true },
  ] as const)(
    "selects only committed explicit output through native finalization: %j",
    async (scenario) => {
      h.mockRunCronFallbackPassthrough();
      h.resolveCronDeliveryPlanMock.mockReturnValue({ requested: true, mode: "announce" });
      const group = "group" in scenario && scenario.group;
      const automatic = "automatic" in scenario && scenario.automatic;
      const pending = "pending" in scenario && scenario.pending;
      const failed = "failed" in scenario && scenario.failed;
      const session = h.makeCronSession();
      session.store["agent:default:source"] = h.makeCronSessionEntry({
        chatType: group ? "group" : "direct",
      });
      h.resolveCronSessionMock.mockReturnValue(session);
      h.runEmbeddedAgentMock.mockImplementationOnce(async ({ runId }) => {
        if (scenario.result !== "missing") {
          createAutomationResultRecorder(
            runId,
            "test-job",
          )(
            scenario.result === "no_change"
              ? { outcome: "no_change" }
              : { outcome: "progress", summary: "Explicit result" },
          );
        }
        return {
          payloads: [
            { text: "Private execution prose" },
            { text: "Private reasoning", isReasoning: true },
          ],
          meta: {
            agentMeta: {},
            ...(pending ? { continuationPending: true } : {}),
            ...(failed ? { error: { message: "Synthetic failure" } } : {}),
          },
        };
      });
      const outcome = await runCronIsolatedAgentTurn(
        makeIsolatedAgentParamsFixture({
          cfg: {
            messages: {
              visibleReplies: automatic || group ? "automatic" : "message_tool",
              ...(group ? { groupChat: { visibleReplies: "message_tool" } } : {}),
            },
          },
          job: makeIsolatedAgentJobFixture({
            ...(scenario.marked ? { legacyHeartbeatReplyPolicy: true } : {}),
            sessionKey: "agent:default:source",
            delivery: { mode: "announce" },
            payload: { kind: "agentTurn", message: "Check", includeReasoning: true },
          }),
        }),
      );
      expect(outcome.status).toBe(failed ? "error" : "ok");
      expect(h.runEmbeddedAgentMock).toHaveBeenCalledOnce();
      if (scenario.marked && !automatic) {
        expect(h.runEmbeddedAgentMock.mock.calls[0]?.[0].sourceReplyDeliveryMode).toBe(
          "message_tool_only",
        );
        const delivery = h.dispatchCronDeliveryMock.mock.calls[0]?.[0];
        expect(delivery).toBeDefined();
        expect(delivery.deliveryPayloads).toEqual(
          scenario.quiet ? [] : [{ text: "Explicit result" }],
        );
        expect(delivery.synthesizedText).toBeUndefined();
        expect(JSON.stringify(delivery.deliveryPayloads)).not.toContain("Private");
      } else {
        expect(
          h.dispatchCronDeliveryMock.mock.calls[0]?.[0].deliveryPayloads.length,
        ).toBeGreaterThan(0);
      }
    },
  );
});
