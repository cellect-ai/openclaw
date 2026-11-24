import { deliverSubagentAnnouncement } from "../../agents/subagents/announce/subagent-announce-delivery.js";
import {
  captureRequesterSessionEntryCurrent,
  loadRequesterSessionEntry,
  withSubagentRequesterSource,
} from "../../agents/subagents/announce/subagent-announce-delivery.runtime.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
  type SessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";

/** One native input owns both the active steer and any proven-rejected direct fallback. */
export async function deliverFiShadowAnnouncement(
  params: Parameters<typeof deliverSubagentAnnouncement>[0],
): ReturnType<typeof deliverSubagentAnnouncement> {
  let input: SessionControllerInput | undefined;
  return withSubagentRequesterSource(
    params.targetRequesterSessionKey,
    params.requesterAgentId,
    async (isSourceCurrent) => {
      const current = await captureRequesterSessionEntryCurrent(
        params.targetRequesterSessionKey,
        params.requesterAgentId,
      );
      try {
        const loaded = await loadRequesterSessionEntry(
          params.targetRequesterSessionKey,
          params.requesterAgentId,
        );
        const entry = loaded.entry;
        if (!entry?.sessionId || !loaded.storePath || !loaded.agentId) {
          throw new Error("Shadow requester has no native target");
        }
        const assertCurrent = () => {
          params.signal?.throwIfAborted();
          const facts = current.readCurrent();
          if (
            isSourceCurrent?.() === false ||
            params.isSourceSessionEffectsAllowed?.() === false ||
            params.isSourceSessionAdmissionAllowed?.() === false ||
            !facts ||
            facts.sessionId !== entry.sessionId ||
            facts.lifecycleRevision !== entry.lifecycleRevision
          ) {
            throw new Error("Shadow requester generation changed");
          }
        };
        const isCurrent = () => {
          try {
            assertCurrent();
            return true;
          } catch {
            return false;
          }
        };
        assertCurrent();
        input = reserveSessionControllerSource(loaded.canonicalKey, {
          reservationId: `fi-shadow:${params.directIdempotencyKey}`,
          protocolRunId: params.directIdempotencyKey,
          sourceSessionId: entry.sessionId,
          policy: { mode: "followup" },
          target: captureSessionTarget({
            storeScope: loaded.storePath,
            physicalStorePath: loaded.physicalStorePath,
            sessionKey: loaded.canonicalKey,
            aliases: [params.targetRequesterSessionKey],
            agentId: loaded.agentId,
            incarnation: entry.sessionId,
          }),
          adapter: {
            scope: loaded.storePath,
            authority: { assertCurrent, signal: params.signal },
            signal: params.signal,
            controlUiVisible: false,
          },
        });
        assertCurrent();
        return await deliverSubagentAnnouncement({
          ...params,
          expectsCompletionMessage: false,
          steerActiveRequester: true,
          completionRequesterSessionId: entry.sessionId,
          completionRequesterLifecycleRevision: entry.lifecycleRevision,
          controllerInput: input,
          isSourceSessionEffectsAllowed: isCurrent,
          isSourceSessionAdmissionAllowed: isCurrent,
        });
      } finally {
        if (input?.custody.rpcAdopted) {
          // Gateway admission now owns input settlement and retained requester authority.
          void input.settlement.promise.then(current.release, current.release);
        } else {
          if (input) {
            retireSessionControllerInput(input);
          }
          current.release();
        }
      }
    },
    () => input,
  );
}
