import type { Deferred } from "../../shared/deferred.js";
import { discardPreparedInboundMedia } from "../chat-attachments.js";
import { formatForLog } from "../ws-log.js";
import type { StartChatDispatchParams } from "./chat-send-agent-dispatch.types.js";
import { createChatSendDispatchErrorLifecycle } from "./chat-send-dispatch-errors.js";
import { emitSessionsChanged } from "./session-change-event.js";

export function settleChatDispatch(
  params: StartChatDispatchParams,
  dispatch: Promise<void>,
  titleTurn: Deferred,
  dispatchErrorLifecycle: ReturnType<typeof createChatSendDispatchErrorLifecycle>,
) {
  const { context, attachments, session, userTurn } = params;
  const { sessionKey, agentId } = session;
  const userTurnRecorder = userTurn.recorder;
  const completion = (async () => {
    try {
      await dispatch;
    } finally {
      // A failed overlapping label may retry after any terminal turn outcome.
      titleTurn.resolve();
      await dispatchErrorLifecycle.finalize();
      // Terminal lifecycle can precede owner release; publish exact liveness after cleanup.
      emitSessionsChanged(
        context,
        { sessionKey, agentId, reason: "agent.input.settled" },
        { accessChanged: false, rowScope: "runtime" },
      );
      if (userTurnRecorder.isBlocked() && attachments.offloadedRefs.length > 0) {
        // A blocked turn persists only the redacted block reason — no media
        // markers — so the prepared inbound media stays unreferenced forever
        // (sweep is off by default). Same custody rule as the pre-ACK owner
        // in chat-send-admission.ts: unreferenced staged media is discarded.
        void discardPreparedInboundMedia(attachments.offloadedRefs);
      }
    }
  })();
  // Ordinary chat.send detaches completion; Goal acknowledgments still consume its rejection.
  void completion.catch((error: unknown) => {
    context.logGateway.warn(`webchat dispatch settlement failed: ${formatForLog(error)}`);
  });
  return completion;
}
