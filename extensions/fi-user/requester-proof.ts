import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import type { ResolvedPluginConfig } from "./fi-delegation.js";

/** A current requester observation from the native run owner, not a credential
 * or a grant. Transports must re-observe it at dispatch and ask Fi for current
 * authorization; retaining this value does not extend the originating run. */
export type ProvenRequester = {
  connection: ResolvedPluginConfig;
  body:
    | { requesterSenderId: string }
    | { requesterMatrixUserId: string }
    | { requesterEmail: string };
};

type RequesterProofContext = Pick<
  OpenClawPluginToolContext,
  | "runId"
  | "agentId"
  | "sessionKey"
  | "messageChannel"
  | "requesterSenderId"
  | "agentAccountId"
  | "hookSourceLockCapability"
  | "hookMailWakeSessionKey"
  | "hostMailWakeEnvironment"
>;

export type RequesterProofReader = (context: RequesterProofContext) => ProvenRequester | undefined;
