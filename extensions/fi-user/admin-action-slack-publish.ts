import { createHash, randomUUID } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  isSlackOrigin,
  type SlackAdminOrigin,
  type SlackReviewerPublication,
} from "./admin-action-origin.js";
import {
  escapeSlack,
  fetchSlackReviewers,
  postSlackText,
  requireSlackReviewers,
  resolveReviewAccountId,
  sendSlackDm,
  sendSlackReviewerCard,
  slackReviewerMessage,
  slackStateLabel,
  updateSlackMessage,
  type SlackCardView,
} from "./admin-action-slack.js";
import { loadAdminAction, transitionAdminAction, type AdminActionRecord } from "./admin-action.js";
import { configFromRuntime, type ResolvedPluginConfig } from "./fi-delegation.js";
import { NOTICE_STORE_OPTIONS, type NoticeOperations } from "./notice-operation-api.js";

export const SLACK_PENDING_NOTE =
  "Sent privately to the organization's administrators in Slack and waiting for the first decision. You will be told here when one decides. Approval and verified execution are separate outcomes.";

type View = (record: AdminActionRecord) => SlackCardView;
const isOpen = (view: View, record: AdminActionRecord) =>
  ["pending", "held"].includes(view(record).status) && !record.execution;

/** What the agent is told: the request's actual state, which a fast reviewer may already have changed. */
export function slackToolResult(record: AdminActionRecord) {
  return ["pending", "held"].includes(record.status) && !record.execution
    ? {
        requestId: record.id,
        status: "pending_approval",
        cardPosted: true,
        tellRequester: SLACK_PENDING_NOTE,
      }
    : {
        requestId: record.id,
        status: record.status === "denied" ? "declined" : record.status,
        cardPosted: true,
        tellRequester:
          "An administrator decided this request while it was being sent. The outcome is posted in this conversation. Approval and verified execution are separate outcomes.",
      };
}

/**
 * Every administrator's private copy shows the current state and keeps its
 * buttons only while a decision is open. A copy not yet sent is sent (an open
 * request only), so a retry reaches whoever missed it. With `announce`, the
 * requester also gets the outcome; a released wire link goes only to their own
 * DM with the bot, never to a channel thread or an administrator's copy.
 */
export async function publishSlackAdminAction(
  api: OpenClawPluginApi,
  record: AdminActionRecord,
  view: View,
  assertCurrent: () => void,
  announce: boolean,
): Promise<AdminActionRecord> {
  const origin = record.origin;
  if (!isSlackOrigin(origin)) {
    throw new Error("Missing approval origin.");
  }
  const message = (r: AdminActionRecord) =>
    slackReviewerMessage(view(r), origin.requesterSlackUserId);
  // Reviewer copies live on the admin agent's account; the requester stays on origin.accountId.
  const reviewAccountId = record.slackReviewAccountId ?? origin.accountId;
  const add = (r: AdminActionRecord, entry: SlackReviewerPublication, account: string) => ({
    ...r,
    slackReviewAccountId: account,
    slackPublications: [...(r.slackPublications ?? []), entry],
  });
  let current = record;
  const known = new Set((record.slackPublications ?? []).map((entry) => entry.slackUserId));
  const justSent = new Set<string>();
  let failures = 0;
  if (isOpen(view, record)) {
    const sendAccount = record.slackReviewAccountId ?? resolveReviewAccountId(api, origin.teamId);
    for (const reviewer of await fetchSlackReviewers(configFromRuntime(api), api.logger.warn)) {
      if (known.has(reviewer)) {
        continue;
      }
      try {
        const sent = await sendSlackReviewerCard(api, {
          accountId: sendAccount,
          teamId: origin.teamId,
          reviewerSlackUserId: reviewer,
          ...message(current),
          assertCurrent,
        });
        const entry: SlackReviewerPublication = { slackUserId: reviewer, ...sent };
        let next = add(current, entry, sendAccount);
        if (!(await transitionAdminAction(api, current, next, assertCurrent))) {
          // Someone changed the request while cards were going out: look again.
          const latest = await loadAdminAction(api, record.id);
          if (latest && isOpen(view, latest)) {
            next = add(latest, entry, sendAccount);
            if (!(await transitionAdminAction(api, latest, next, assertCurrent))) {
              // Never leave a live card that nothing recorded.
              const superseded = "This copy is out of date; nothing can be decided from it.";
              await updateSlackMessage(api, {
                accountId: sendAccount,
                teamId: origin.teamId,
                assertCurrent,
                ...sent,
                text: superseded,
                blocks: [{ type: "section", text: { type: "plain_text", text: superseded } }],
              }).catch(() => undefined);
              throw new Error("Approval publication could not be recorded.");
            }
          } else {
            // Decided meanwhile: stop sending and bring this copy to the decided state.
            await updateSlackMessage(api, {
              accountId: sendAccount,
              teamId: origin.teamId,
              assertCurrent,
              ...sent,
              ...message(latest ?? current),
            }).catch(() => undefined);
            current = latest ?? current;
            justSent.clear();
            break;
          }
        }
        current = next;
        known.add(reviewer);
        justSent.add(reviewer);
      } catch {
        failures += 1;
      }
    }
  }
  for (const entry of current.slackPublications ?? []) {
    if (!justSent.has(entry.slackUserId)) {
      try {
        assertCurrent();
        await updateSlackMessage(api, {
          accountId: current.slackReviewAccountId ?? reviewAccountId,
          teamId: origin.teamId,
          assertCurrent,
          ...entry,
          ...message(current),
        });
      } catch {
        failures += 1;
      }
    }
  }
  if (failures) {
    api.logger.warn(`fi-user: ${failures} Slack approval card delivery or update(s) failed`);
  }
  if (!current.slackPublications?.length) {
    throw new Error("Approval publication has no native receipt; nothing can be approved.");
  }
  if (announce) {
    await announceOutcome(api, current, view(current), origin, assertCurrent);
  }
  return current;
}

async function announceOutcome(
  api: OpenClawPluginApi,
  record: AdminActionRecord,
  card: SlackCardView,
  origin: SlackAdminOrigin,
  assertCurrent: () => void,
) {
  const mention = `<@${origin.requesterSlackUserId}>`;
  const headline = `${mention} ${escapeSlack(card.title)}: ${slackStateLabel(card)}`;
  const post = async (text: string) => {
    assertCurrent();
    await postSlackText(api, {
      accountId: origin.accountId,
      teamId: origin.teamId,
      assertCurrent,
      channelId: origin.channelId,
      ...(origin.threadTs ? { threadTs: origin.threadTs } : {}),
      text,
    });
  };
  const wiring = record.execution?.wiringReceipt;
  if (!wiring) {
    // A wiring request names a company and recipient: never in a channel thread.
    const inPrivate = origin.channelId.startsWith("D");
    await post(
      record.preparedWiring && !inPrivate ? headline : `${headline}\n${escapeSlack(card.summary)}`,
    );
    return;
  }
  const details = `${headline}\n${escapeSlack(wiring.companyName)}\nRecipient: ${escapeSlack(wiring.recipientEmail)}\n${wiring.url}\nExpires: ${escapeSlack(wiring.expiresAt)}`;
  await sendSlackDm(api, {
    accountId: origin.accountId,
    teamId: origin.teamId,
    assertCurrent,
    userId: origin.requesterSlackUserId,
    text: details,
  });
  try {
    await post(`${headline}. I sent the details to ${mention} privately.`);
  } catch {
    api.logger.warn("fi-user: wire-link delivered privately; thread note could not be posted");
  }
}

/** A repeat of the same notice within 30 minutes, or a sixth in an hour, sends nothing. */
async function claimNotice(
  api: OpenClawPluginApi,
  config: ResolvedPluginConfig,
  origin: SlackAdminOrigin,
  label: string,
  description: string,
  assertCurrent: () => void,
): Promise<
  { ok: true; release: () => Promise<void> } | { ok: false; reason: "duplicate" | "cap" }
> {
  const store = api.runtime.state.openKeyedStore(NOTICE_STORE_OPTIONS);
  const operation = store.createOperation!<NoticeOperations>(
    [store],
    { moduleName: "notice-operation-api.js", exportName: "runNoticeOperation" },
    { assertCurrent },
  );
  const who = `${config.tenantOrgId}:${origin.requesterSlackUserId}`;
  const digest = createHash("sha256")
    .update(`${label}\n${description.toLowerCase().replace(/\s+/g, " ")}`)
    .digest("hex")
    .slice(0, 32);
  const claimId = randomUUID();
  const input = {
    countPrefix: `count:${who}:`,
    dedupeKey: `dedupe:${who}:${digest}`,
    countKey: `count:${who}:${Date.now()}:${claimId}`,
    claimId,
  };
  const receipt = await operation.execute(
    { type: "claim", input },
    { writeStores: [0], watchStores: [] },
  );
  receipt.assertCurrent();
  if (!receipt.value.ok) {
    return receipt.value;
  }
  return {
    ok: true,
    release: async () => {
      await operation.execute({ type: "release", input }, { writeStores: [0], watchStores: [] });
    },
  };
}

/**
 * A Slack request nobody can approve (no typed operation): tell each reviewer,
 * with no buttons and no stored state, that an administrator has to do it.
 */
export async function sendSlackNotice(
  api: OpenClawPluginApi,
  config: ResolvedPluginConfig,
  origin: SlackAdminOrigin,
  notice: { label: string; description: string },
  assertCurrent: () => void,
) {
  const { reviewers, accountId: reviewAccountId } = await requireSlackReviewers(
    api,
    config,
    origin.teamId,
  );
  const description = notice.description
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replaceAll("`", "'")
    .trim()
    .slice(0, 500);
  const claim = await claimNotice(api, config, origin, notice.label, description, assertCurrent);
  if (!claim.ok) {
    return {
      status: "not_executable",
      cardPosted: false,
      administratorsNotified: 0,
      tellRequester:
        claim.reason === "cap"
          ? "Too many administrator notices were sent for this person in the last hour. Nothing was sent; try again later or ask an administrator directly."
          : "The administrators were already notified of this request recently. Nothing was executed and nothing more was sent.",
    };
  }
  // A code block keeps Slack from linking or formatting what the requester wrote.
  const fence = "```";
  const text = [
    `<@${origin.requesterSlackUserId}> asked for: ${escapeSlack(notice.label)}`,
    `${fence}\n${escapeSlack(description)}\n${fence}`,
    "This needs an administrator to do it (for example with the Admin agent). Nothing has been executed and there is nothing to approve here.",
  ].join("\n");
  let notified = 0;
  for (const userId of reviewers) {
    try {
      await sendSlackDm(api, {
        accountId: reviewAccountId,
        teamId: origin.teamId,
        userId,
        text,
        assertCurrent,
      });
      notified += 1;
    } catch {
      api.logger.warn("fi-user: an administrator notice could not be delivered");
    }
  }
  if (!notified) {
    await claim.release();
    throw new Error("The administrators could not be notified in Slack. Nothing was executed.");
  }
  return {
    status: "not_executable",
    cardPosted: false,
    administratorsNotified: notified,
    tellRequester:
      "The administrators were notified privately in Slack. Nothing was executed and nothing is awaiting approval; an administrator has to do this themselves (for example with the Admin agent).",
  };
}
