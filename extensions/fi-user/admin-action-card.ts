import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  ADMIN_TASKS,
  RECORD_TTL_MS,
  transitionAdminAction,
  type AdminActionRecord,
} from "./admin-action.js";
import type { ResolvedPluginConfig } from "./fi-delegation.js";

/** Only host-selected routing and explicit account identity bind a business request. */
export function prepareAdminActionOrigin(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext,
  config: ResolvedPluginConfig,
): NonNullable<AdminActionRecord["origin"]> {
  const route = context.deliveryContext;
  const accountId = context.agentAccountId ?? route?.accountId;
  const cfg = context.getRuntimeConfig?.() ?? context.runtimeConfig ?? api.runtime.config.current();
  const matrix = asOptionalRecord(cfg.channels?.matrix);
  const account = asOptionalRecord(asOptionalRecord(matrix?.accounts)?.[accountId ?? ""]);
  const agentMxid = account?.userId;
  const roomId = route?.to?.replace(/^room:/, "");
  const threadRootEventId = route?.threadId;
  if (
    !config.tenantOrgId ||
    config.tenantOrgConflict ||
    route?.channel !== "matrix" ||
    !accountId ||
    (route.accountId && route.accountId !== accountId) ||
    typeof agentMxid !== "string" ||
    !/^@[^\s:]+:[^\s]+$/.test(agentMxid) ||
    !roomId ||
    !/^![^\s:]+:[^\s]+$/.test(roomId) ||
    typeof threadRootEventId !== "string" ||
    !threadRootEventId.startsWith("$") ||
    (context.nativeChannelId && context.nativeChannelId !== roomId)
  ) {
    throw new Error("Cannot bind this approval to a verified Fi conversation and account.");
  }
  return { orgId: config.tenantOrgId, roomId, threadRootEventId, agentMxid };
}

const singleLine = (value: string, max: number) =>
  value
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ")
    .trim()
    .slice(0, max) || "Review this administrator request.";

/** A card is a projection, never an approval authority or a generic question. */
export function adminActionCard(record: AdminActionRecord) {
  const state =
    ["pending", "held"].includes(record.status) && Date.now() >= record.createdAt + RECORD_TTL_MS
      ? "expired"
      : record.status === "denied"
        ? "declined"
        : ["done", "failed"].includes(record.status)
          ? "approved"
          : record.status;
  const prepared = record.preparedFiling;
  const title = prepared ? `File ${prepared.input.displayName}` : ADMIN_TASKS[record.task].label;
  const targetSummary = prepared
    ? `${prepared.documentFilename === prepared.input.displayName ? "" : `Source: ${prepared.documentFilename}. `}${prepared.roomName} / ${prepared.input.section}; ${prepared.input.noOrder ? "no order" : `order ${prepared.input.order}`}; ${prepared.input.visibility}. ${
        prepared.tasks.some((task) => !task.complete)
          ? `Link: ${prepared.tasks
              .filter((task) => !task.complete)
              .map((task) => task.title)
              .join(", ")}. `
          : ""
      }${
        prepared.tasks.some((task) => task.complete)
          ? `Link/complete: ${prepared.tasks
              .filter((task) => task.complete)
              .map((task) => task.title)
              .join(", ")}.`
          : prepared.tasks.length
            ? ""
            : "No checklist links."
      }${prepared.input.acknowledgeRestricted ? " Restricted sharing." : ""}${prepared.input.tag.length ? ` Tags: ${prepared.input.tag.join(", ")}.` : ""}${prepared.input.highlight ? " Highlighted." : ""}`
    : undefined;
  // Never hide part of the approved target behind a truncated count or label.
  // Oversized requests must be narrowed before a decision control is published.
  if (
    targetSummary &&
    !record.execution &&
    (targetSummary.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ").trim().length > 280 ||
      title.length > 80)
  ) {
    throw new Error(
      "The exact filing targets do not fit this approval card. Narrow the request before asking for approval.",
    );
  }
  return {
    type: "m.cellect.decision",
    version: 1,
    kind: "workflowApproval",
    id: record.id,
    revision: record.revision ?? 1,
    status: state,
    title: singleLine(title, 80),
    summary: singleLine(
      record.execution?.message ??
        targetSummary ??
        (record.fields.displayName && record.fields.roomName
          ? `${record.fields.displayName} → ${record.fields.roomName}, ${record.fields.section ?? "section unresolved"}; ${record.fields.visibility ?? "visibility unresolved"}${record.fields.order ? `; order ${record.fields.order}` : "; no order"}; ${record.fields.taskIds?.length ?? 0} checklist links, ${record.fields.completeTaskIds?.length ?? 0} completions${record.fields.acknowledgeRestricted ? "; restricted sharing requested" : ""}.`
          : record.fields.description) ??
        "Review the exact requested action. Approval is separate from completion.",
      280,
    ),
    decisions: state === "held" ? ["resume", "decline"] : ["approve", "hold", "decline"],
    expiresAtMs: record.createdAt + RECORD_TTL_MS,
    workflowRef: `admin-action:${record.id}`,
    ...((state === "approved" || state === "declined") && record.decidedBy?.startsWith("@")
      ? { decidedByUserId: record.decidedBy }
      : {}),
  };
}

export async function publishAdminActionCard(
  api: OpenClawPluginApi,
  record: AdminActionRecord,
  assertCurrent: () => void = () => {},
): Promise<void> {
  if (!record.origin || !record.delivery?.accountId) throw new Error("Missing approval origin.");
  const adapter = await api.runtime.channel.outbound.loadAdapter("matrix");
  if (!adapter?.sendPayload) throw new Error("Decision-card delivery is unavailable.");
  assertCurrent();
  const card = adminActionCard(record);
  const result = await adapter.sendPayload({
    cfg: api.runtime.config.current(),
    to: record.origin.roomId,
    accountId: record.delivery.accountId,
    threadId: record.origin.threadRootEventId,
    assertDirectAdapterHandoff: assertCurrent,
    payload: {
      text: `${card.title}\n${card.summary}`,
      channelData: {
        matrix: {
          ...(record.publicationEventId ? { editEventId: record.publicationEventId } : {}),
          extraContent: { "ai.cellect.card": card },
        },
      },
    },
  });
  if (!record.publicationEventId) {
    const eventId = result.messageId;
    if (typeof eventId !== "string" || !eventId.startsWith("$")) {
      throw new Error("Approval publication has no native receipt; nothing can be approved.");
    }
    if (
      !(await transitionAdminAction(
        api,
        record,
        { ...record, publicationEventId: eventId },
        assertCurrent,
      ))
    ) {
      throw new Error("Approval publication could not be recorded; nothing was executed.");
    }
  }
}
