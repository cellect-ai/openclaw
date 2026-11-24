import { claimAgentRunContext } from "../../infra/agent-run-registry.js";
import { progressCardRefreshRunProjection } from "../../sessions/input-provenance.js";
import type { ChatSendAdmissionParams } from "./chat-send-pre-admission.types.js";

export function claimChatSendRunContext(
  params: ChatSendAdmissionParams,
  admittedSessionId: string,
  lifecycleGeneration: string,
) {
  const {
    request,
    session: { clientRunId, selectedAgent, agentId, sessionKey },
  } = params;
  claimAgentRunContext(clientRunId, {
    agentId: selectedAgent.agentId ?? agentId,
    sessionKey,
    sessionId: admittedSessionId,
    lifecycleGeneration,
    ...progressCardRefreshRunProjection(request.systemInputProvenance),
  });
}
