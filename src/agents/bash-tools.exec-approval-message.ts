import {
  resolveExecApprovalAllowedDecisions,
  type ExecApprovalDecision,
} from "../infra/exec-approvals.js";
import { formatFencedCodeBlock } from "../shared/markdown-code.js";

const DEFAULT_APPROVAL_RUNNING_NOTICE_MS = 10_000;
const APPROVAL_SLUG_LENGTH = 8;

/** Creates the short approval id shown in `/approve` prompts. */
export function createApprovalSlug(id: string) {
  return id.slice(0, APPROVAL_SLUG_LENGTH);
}

/** Builds the user-facing approval-pending message for foreground exec. */
export function buildApprovalPendingMessage(params: {
  warningText?: string;
  approvalSlug: string;
  approvalId: string;
  allowedDecisions?: readonly ExecApprovalDecision[];
  command: string;
  cwd: string | undefined;
  host: "gateway" | "node";
  nodeId?: string;
  processContinuationAvailable?: boolean;
}) {
  const commandBlock = formatFencedCodeBlock(params.command, "sh");
  const lines: string[] = [];
  const allowedDecisions = params.allowedDecisions ?? resolveExecApprovalAllowedDecisions();
  const decisionText = allowedDecisions.join("|");
  const warningText = params.warningText?.trim();
  if (warningText) {
    lines.push(warningText, "");
  }
  lines.push(`Approval required (id ${params.approvalSlug}, full ${params.approvalId}).`);
  lines.push(`Host: ${params.host}`);
  if (params.nodeId) {
    lines.push(`Node: ${params.nodeId}`);
  }
  lines.push(`CWD: ${params.cwd ?? "(node default)"}`);
  lines.push("Command:");
  lines.push(commandBlock);
  lines.push("Mode: foreground (interactive approvals available).");
  if (params.processContinuationAvailable !== false) {
    lines.push(
      allowedDecisions.includes("allow-always")
        ? "Background mode requires pre-approved policy (allow-always or ask=off)."
        : "Background mode requires an effective policy that allows pre-approval (for example ask=off).",
    );
  }
  lines.push(`Reply with: /approve ${params.approvalSlug} ${decisionText}`);
  if (!allowedDecisions.includes("allow-always")) {
    lines.push("Allow Always is unavailable for this command.");
  }
  lines.push("If the short code is ambiguous, use the full id in /approve.");
  return lines.join("\n");
}

export function resolveApprovalRunningNoticeMs(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_APPROVAL_RUNNING_NOTICE_MS;
  }
  if (value <= 0) {
    return 0;
  }
  return Math.floor(value);
}
