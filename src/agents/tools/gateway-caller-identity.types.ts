import type { ExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { type SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { CronCreatorAuthorityGrant } from "../../gateway/cron-creator-authority-grant.types.js";
import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
import type { GatewayUiCommandTarget } from "../../gateway/ui-command-target.types.js";
import type { WorkerSessionTurnClaim } from "../../gateway/worker-environments/placement-record.js";
import type { WorkerTurnExecutionIdentityCapability } from "../../gateway/worker-environments/placement-turn-claim-events.js";
import { type AgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import type { BusinessApprovalConversation } from "../../infra/business-approval-conversation.js";
import type { ReplyTurnParticipants } from "../../sessions/session-controller.contracts.js";
import type { SessionControllerWatchdogAttempt } from "../../sessions/session-controller.watchdog.js";
import {
  type AdmittedRunOperatorAuthority,
  type OperationalRunInstanceRef,
} from "../admitted-run-context.js";
import { type EmbeddedRunToolAuthorityBinding } from "../embedded-agent-runner/run-state.js";
import { type RequesterOrigin } from "../requester-origin.js";
import type { GatewayToolCallerReceiptAdmission } from "./gateway-caller-receipt.types.js";

export type ReceiptAuthority = (() => boolean | void) &
  Pick<SessionSourceAssertion, keyof SessionSourceAssertion>;

export type GatewayToolCallerIdentity = {
  watchdogAttempt?: SessionControllerWatchdogAttempt;
  personalToolParticipants?: ReplyTurnParticipants;
  personalToolUser?: string;
  personalToolIdentityScoped?: true;
  personalToolSelection?: GatewayToolOperatorSelection;
  agentId: string;
  sessionKey: string;
  requesterOrigin?: RequesterOrigin;
  /** Restrict-only executable surface captured for internal follow-ups. */
  sessionEventToolsAllow?: readonly string[];
  /** An object with no mode retains the producer's default permission posture. */
  sessionEventSettings?: Readonly<Pick<SessionEntry, "permissionMode" | "toolOverrides">>;
  /** Follow-ups cannot add automatic delivery to a message-tool-only source. */
  sessionEventDelivery?: false;
  gatewayUiCommandTarget?: GatewayUiCommandTarget;
  /** Prepared requesting-tool posture; absent authority never bypasses approvals. */
  fullPermission?: boolean;
  /** Host-held current delegation grant. A posture boolean alone never authorizes a write. */
  assertAutoApproveChangesCurrent?: () => void;
  operationalRunInstance?: OperationalRunInstanceRef;
  embeddedRunToolAuthorityBinding?: EmbeddedRunToolAuthorityBinding;
  /** Exact run authority used to fence delegated system-agent approvals. */
  approvalAuthority?: AgentRunDelegatedAuthority;
  /** Original operator restriction, separate from this tool/turn's execution lifetime. */
  operatorAuthority?: AdmittedRunOperatorAuthority;
  approvalAuthorityCheck?: () => boolean | void;
  /** Exact host-resolved owner of this individual approval request. */
  approvalOwnerPluginId?: string;
  /** Host-minted business approval provenance, never model/RPC parameters. */
  approvalOrigin?: "plugin";
  approvalConversation?: BusinessApprovalConversation;
  /** Host-owned tool/turn lifetimes; every same-run wrapper preserves earlier fences. */
  approvalSignals?: readonly AbortSignal[];
  /** Opaque already-signed identity used only by isolated worker transports. */
  signedAgentRuntimeIdentityToken?: string;
  executionIdentityToken?: ExecutionIdentityAdmissionToken;
  /** Synchronous host-owned fence for tool effects and decision receipts. */
  receiptAuthority?: ReceiptAuthority;
  receiptAdmissions?: readonly GatewayToolCallerReceiptAdmission[];
  /** Captured conversation policy for tools delegated through another tool's transport. */
  assertToolAllowed?: (toolName: string) => void;
  /** Exact Gateway-owned worker claim; never sourced from model or RPC arguments. */
  workerTurnClaim?: WorkerSessionTurnClaim;
  /** Prepared caller sandbox for the explicit current-workspace base refresh; never RPC data. */
  workspaceBaseRefreshSandbox?: import("../sandbox/types.js").SandboxContext;
  /** Host handoff selects the exact settled conversation; never accepted from RPC input. */
  workspacePrAdoptionSessionId?: string;
  /** Current tool's filesystem owner for inspected PR evidence; never serialized in RPC data. */
  workspaceEvidenceSandbox?: import("../sandbox/types.js").SandboxContext;
  /** Closure-bound Gateway capability; revalidates both owners at child admission. */
  workerTurnExecutionIdentityCapability?: WorkerTurnExecutionIdentityCapability;
  /** Instance-bound routing only; delegated authority is revalidated separately. */
  gatewayContextResolver?: GatewayContextResolver;
  /** Host-signed capability for the scheduled run's existing self-management surface. */
  cronSelfManagementJobId?: string;
  cronToolsAllowCapture?: "final-executable-surface";
  /** Restrict-only policy enforced by exec on the captured creator surface. */
  cronExecToolTarget?: { host: "gateway"; ask?: "always" };
  /** One-shot Gateway-owned proof for a freshly resolved configured-MCP cap. */
  cronCreatorAuthorityGrant?: CronCreatorAuthorityGrant;
  /** Host-only native issuer retained by the current MCP grant; never serialized. */
  mintCronRequesterGrant?: (signal?: AbortSignal) => CronCreatorAuthorityGrant;
  cronManagementGrant?: CronCreatorAuthorityGrant;
  /** Cron permission can end while the admitted run retains its other tools. */
  cronAuthorityCheck?: () => boolean;
  // Trusted run context, carried separately from model-authored tool arguments.
  turnSourceChannel?: string;
  turnSourceLocal?: true;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
};

export type GatewayToolCallerSource = {
  agentSessionKey?: string;
  gatewayUiCommandTarget?: GatewayUiCommandTarget;
  agentChannel?: string;
  currentMessagingTarget?: string;
  currentChannelId?: string;
  agentTo?: string;
  agentAccountId?: string;
  currentThreadTs?: string;
  agentThreadId?: string | number;
};

export type GatewayToolOperatorSelection = Readonly<{
  /** Raw host-issued source; custody transfers must not retain the turn-bound assertion. */
  operatorAuthority?: AdmittedRunOperatorAuthority;
  requesterOrigin?: RequesterOrigin;
  assertCurrent: () => void;
}>;
