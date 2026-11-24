import { ADMIN_TASKS, type AdminActionRecord } from "./admin-action.js";
import type { ResolvedPluginConfig } from "./fi-delegation.js";

export function describe(record: AdminActionRecord): string {
  const f = record.fields;
  const lines = [
    f.project ? `Project: ${f.project}` : undefined,
    f.submissionId ? `E-sign envelope: ${f.submissionId}` : undefined,
    f.currentSignerEmail ? `Current signer: ${f.currentSignerEmail}` : undefined,
    f.newSignerEmail ? `New signer: ${f.newSignerEmail}` : undefined,
    f.documentId ? `Document: ${f.documentId}` : undefined,
    f.recipientEmail ? `Share with: ${f.recipientEmail}` : undefined,
    f.roomId ? `Data room: ${f.roomId}` : undefined,
    record.task === "restricted_filing" && f.destination === "project_library"
      ? `Destination: the project's document library (not a data room)${f.category ? `, category ${f.category}` : ""}${f.section ? `, section ${f.section}` : ""}`
      : undefined,
    f.slackFileId ? `Slack file: ${f.slackFileId}` : undefined,
    f.targetType ? `Access to: ${f.targetType}${f.targetId ? ` ${f.targetId}` : ""}` : undefined,
    f.description ? `What: ${f.description}` : undefined,
    f.reason ? `Why: ${f.reason}` : undefined,
  ];
  return lines.filter(Boolean).join("\n");
}

function requesterMention(record: AdminActionRecord): string {
  const identity = record.requester.identity;
  return identity.channel === "slack" ? `<@${identity.requesterSenderId}>` : record.requester.email;
}

export function approvalCardText(record: AdminActionRecord, config: ResolvedPluginConfig): string {
  if (record.origin) {
    return `${ADMIN_TASKS[record.task].label}\n${describe(record)}\nUse the decision card to Approve, Hold, or Decline. Approval does not itself mean the action completed.`;
  }
  const principals = config.adminPrincipals.map((id) =>
    /^U[A-Z0-9]+$/i.test(id) ? `<@${id}>` : id,
  );
  // Only a reply Slack verified decides a request, so a card posted anywhere
  // else must send the approver to Slack rather than invite a reply in place.
  const where = record.requester.identity.channel === "slack" ? "in this thread" : "in Slack";
  return [
    `Admin action ${record.id} requested by ${requesterMention(record)} (${record.requester.email}): ${ADMIN_TASKS[record.task].label}`,
    describe(record),
    `${principals.join(" ")}${principals.length ? " — " : ""}reply \`approve ${record.id}\` or \`deny ${record.id}\` ${where}. Approval is recorded separately from execution; unsupported actions are not executed.`,
  ]
    .filter(Boolean)
    .join("\n");
}
