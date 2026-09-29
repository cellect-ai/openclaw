// Slack channel guard: warn, without an LLM, when a message appears to carry bank payment details.
import { createDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { mergeSlackAccountConfig } from "../accounts.js";
import type { SlackMessageEvent } from "../types.js";
import { normalizeSlackChannelType } from "./channel-type.js";
import type { SlackMonitorContext } from "./context.js";
import type { SlackEventScope } from "./event-scope.js";

export type SlackPaymentDetailSignal = "aba-routing" | "bank-account" | "iban" | "swift";

// The warning never quotes the message, so it cannot re-broadcast the numbers it flags.
export const SLACK_PAYMENT_DETAIL_WARNING_TEXT =
  ":warning: This message looks like it contains bank or wire details. Please don't share payment instructions in Slack: they can be spoofed or altered. Send them through the verified payment-instructions process, and confirm any new or changed instructions by calling a known contact before paying.";

// Keyword windows are measured in characters on either side of the number.
const KEYWORD_WINDOW = 40;
const ROUTING_KEYWORD_RE = /\b(?:routing|aba|rtn)\b/iu;
const ACCOUNT_KEYWORD_RE = /\b(?:account|acct|a\/c)\b/iu;
const BANK_CONTEXT_RE =
  /\b(?:bank|wire|ach|routing|aba|checking|savings|beneficiary|swift|iban)\b/iu;
const SWIFT_KEYWORD_RE = /\b(?:swift|bic)\b/iu;
const NINE_DIGITS_RE = /(?<![\d-])\d{9}(?![\d-])/gu;
const ACCOUNT_DIGITS_RE = /(?<![\d-])\d{6,17}(?![\d-])/gu;
const IBAN_RE = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/gu;
const SWIFT_RE = /\b[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/gu;
// A BIC's fifth and sixth characters are an ISO 3166 country code, which keeps
// ordinary eight-letter words ("TRANSFER") near "SWIFT" from matching.
const ISO_COUNTRY_CODES = new Set(
  (
    "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ " +
    "LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW"
  ).split(" "),
);
// First two ABA digits: Federal Reserve districts, thrifts, electronic and traveler's checks.
const ABA_PREFIX_RE = /^(?:0[0-9]|1[0-2]|2[1-9]|3[0-2]|6[1-9]|7[0-2]|80)/u;

function nearKeyword(text: string, index: number, length: number, keyword: RegExp): boolean {
  const start = Math.max(0, index - KEYWORD_WINDOW);
  return keyword.test(text.slice(start, index + length + KEYWORD_WINDOW));
}

function isAbaRoutingNumber(digits: string): boolean {
  if (!ABA_PREFIX_RE.test(digits)) {
    return false;
  }
  const d = [...digits].map(Number);
  const sum = 3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + (d[2]! + d[5]! + d[8]!);
  return sum % 10 === 0;
}

function isValidIban(candidate: string): boolean {
  const iban = candidate.replace(/ /gu, "");
  if (iban.length < 15 || iban.length > 34) {
    return false;
  }
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`;
  let remainder = 0;
  for (const char of rearranged) {
    const value = /\d/u.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of value) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

/** Deterministically detects payment-instruction details; returns the matched signal kinds. */
export function detectSlackPaymentDetails(text: string): SlackPaymentDetailSignal[] {
  const signals = new Set<SlackPaymentDetailSignal>();
  for (const match of text.matchAll(NINE_DIGITS_RE)) {
    if (
      isAbaRoutingNumber(match[0]) &&
      nearKeyword(text, match.index, match[0].length, ROUTING_KEYWORD_RE)
    ) {
      signals.add("aba-routing");
    }
  }
  if (BANK_CONTEXT_RE.test(text)) {
    for (const match of text.matchAll(ACCOUNT_DIGITS_RE)) {
      if (nearKeyword(text, match.index, match[0].length, ACCOUNT_KEYWORD_RE)) {
        signals.add("bank-account");
      }
    }
  }
  for (const match of text.matchAll(IBAN_RE)) {
    if (isValidIban(match[0])) {
      signals.add("iban");
    }
  }
  for (const match of text.matchAll(SWIFT_RE)) {
    if (
      ISO_COUNTRY_CODES.has(match[0].slice(4, 6)) &&
      nearKeyword(text, match.index, match[0].length, SWIFT_KEYWORD_RE)
    ) {
      signals.add("swift");
    }
  }
  return [...signals];
}

function collectSlackMessageScanText(message: SlackMessageEvent): string {
  const parts = [message.text];
  for (const attachment of message.attachments ?? []) {
    parts.push(attachment.pretext, attachment.text, attachment.fallback);
  }
  for (const file of message.files ?? []) {
    const record = file as { title?: unknown; preview?: unknown; plain_text?: unknown };
    for (const value of [record.title, record.preview, record.plain_text]) {
      parts.push(typeof value === "string" ? value : undefined);
    }
  }
  return parts.filter((part): part is string => Boolean(part?.trim())).join("\n");
}

// Shared across accounts in this gateway, so several bots in one channel warn once.
const SLACK_PAYMENT_WARNING_KEY = Symbol.for("openclaw.slackPaymentDetailWarnings");
const warnedMessages = resolveGlobalSingleton(SLACK_PAYMENT_WARNING_KEY, () =>
  createDedupeCache({ ttlMs: 24 * 60 * 60 * 1_000, maxSize: 5_000 }),
);

/**
 * Posts one threaded warning when an inbound channel message carries bank
 * details. Opt-in via channels.slack.paymentDetailWarning; never echoes the numbers.
 */
export async function maybeWarnSlackPaymentDetails(params: {
  ctx: SlackMonitorContext;
  message: SlackMessageEvent;
  eventScope?: SlackEventScope;
}): Promise<boolean> {
  const { ctx, message, eventScope } = params;
  try {
    if (!ctx.cfg || !mergeSlackAccountConfig(ctx.cfg, ctx.accountId).paymentDetailWarning) {
      return false;
    }
    const isUserPost =
      !message.subtype ||
      message.subtype === "file_share" ||
      message.subtype === "thread_broadcast";
    if (!isUserPost || message.bot_id || !message.user || !message.channel || !message.ts) {
      return false;
    }
    const channelType = normalizeSlackChannelType(message.channel_type, message.channel);
    if (channelType !== "channel" && channelType !== "group") {
      return false;
    }
    const signals = detectSlackPaymentDetails(collectSlackMessageScanText(message));
    if (signals.length === 0) {
      return false;
    }
    const teamId = eventScope?.teamId ?? ctx.teamId;
    const channelName = (await ctx.resolveChannelName(message.channel, eventScope)).name;
    if (!ctx.isChannelAllowed({ teamId, channelId: message.channel, channelName, channelType })) {
      return false;
    }
    if (warnedMessages.check(`${teamId}:${message.channel}:${message.ts}`)) {
      return false;
    }
    // Posted directly, not through the reply sender, so the warning does not
    // count as thread participation and make the bot answer follow-ups.
    const client = eventScope?.client ?? ctx.app.client;
    const postChatMessage = client.chat.postMessage.bind(client.chat);
    await postChatMessage({
      channel: message.channel,
      thread_ts: message.thread_ts ?? message.ts,
      text: SLACK_PAYMENT_DETAIL_WARNING_TEXT,
    });
    logVerbose(
      `slack: payment-detail warning posted channel=${message.channel} ts=${message.ts} signals=${signals.join(",")}`,
    );
    return true;
  } catch (err) {
    ctx.runtime.error?.(`slack payment-detail warning failed: ${formatErrorMessage(err)}`);
    return false;
  }
}

export function clearSlackPaymentDetailWarningsForTest(): void {
  warnedMessages.clear();
}
