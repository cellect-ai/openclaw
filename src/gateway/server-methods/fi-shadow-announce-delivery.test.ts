import { expect, it, vi } from "vitest";
import * as configRuntime from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { deliverFiShadowAnnouncement } from "./fi-shadow-announce-delivery.js";

const { deliver } = vi.hoisted(() => ({
  deliver:
    vi.fn<
      typeof import("../../agents/subagents/announce/subagent-announce-delivery.js").deliverSubagentAnnouncement
    >(),
}));
vi.mock("../../agents/subagents/announce/subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: deliver,
}));

it.each(["unchanged", "metadata", "lifecycle", "session", "cancelled"] as const)(
  "keeps exact native requester authority through %s changes",
  async (change) => {
    await withOpenClawTestState({ label: `shadow-target-${change}` }, async () => {
      const agentId = "main";
      const sessionKey = "agent:main:main";
      const storePath = resolveOpenClawAgentSqlitePath({ agentId });
      const scope = { agentId, sessionKey, storePath };
      const entry = { sessionId: "requester", lifecycleRevision: "generation", updatedAt: 1 };
      const controller = new AbortController();
      const config = vi
        .spyOn(configRuntime, "getRuntimeConfig")
        .mockReturnValue({ session: { store: storePath } });
      try {
        await replaceSessionEntry(scope, entry);
        deliver.mockImplementationOnce(async (params) => {
          expect(params.controllerInput?.target).toMatchObject({
            storeScope: storePath,
            sessionKey,
            agentId,
            incarnation: entry.sessionId,
          });
          expect(params).toMatchObject({
            expectsCompletionMessage: false,
            steerActiveRequester: true,
            completionRequesterSessionId: "requester",
            completionRequesterLifecycleRevision: "generation",
          });
          expect(params.isSourceSessionAdmissionAllowed?.()).toBe(true);
          if (change === "cancelled") {
            controller.abort();
          }
          if (change === "lifecycle" || change === "session" || change === "metadata") {
            await replaceSessionEntry(scope, {
              ...entry,
              updatedAt: 2,
              ...(change === "lifecycle" ? { lifecycleRevision: "replacement" } : {}),
              ...(change === "session" ? { sessionId: "replacement" } : {}),
            });
          }
          const expected = change === "unchanged" || change === "metadata";
          expect(params.isSourceSessionAdmissionAllowed?.()).toBe(expected);
          expect(params.isSourceSessionEffectsAllowed?.()).toBe(expected);
          if (expected) {
            expect(() =>
              params.controllerInput?.sourceAdapter?.authority?.assertCurrent(),
            ).not.toThrow();
          } else {
            expect(() =>
              params.controllerInput?.sourceAdapter?.authority?.assertCurrent(),
            ).toThrow();
          }
          return { delivered: expected, path: expected ? "steered" : "none" };
        });
        await deliverFiShadowAnnouncement({
          requesterSessionKey: sessionKey,
          requesterAgentId: agentId,
          targetRequesterSessionKey: sessionKey,
          triggerMessage: "fixed",
          expectsCompletionMessage: false,
          requesterIsSubagent: false,
          directIdempotencyKey: `shadow-${change}`,
          signal: controller.signal,
        });
      } finally {
        config.mockRestore();
        deliver.mockReset();
      }
    });
  },
);
