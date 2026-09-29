// Pushes a plain-text notice to a human operator when a DM access request
// needs attention, instead of leaving it discoverable only by tailing
// gateway logs or running the CLI speculatively.
//
// `recordChannelPairingRequested` and the staleness sweep already warn on
// the pairing subsystem logger, but the gateway only archives that log for
// later reading (see docs/channels/pairing.md); nothing surfaces it live.
// This reuses the same "who is the human operator" concept already used for
// `commands.ownerAllowFrom` -- falling back to the requested channel
// account's own configured DM allowlist, so an account without a configured
// global owner still reaches someone who already talks to that exact bot --
// to send the same notice as an ordinary message, on a channel a human
// already has open. It never crosses into another account's allowlist.
//
// This never grants access and never adds a button or an interactivity
// endpoint: it only tells someone the exact `openclaw pairing` command to
// run. Approval stays in the CLI.
import { getLoadedChannelPlugin } from "../channels/plugins/index.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import {
  formatPairingListHint,
  onChannelPairingRequested,
  type ChannelPairingRequestedNotice,
} from "./pairing-request-notice.js";

const log = createSubsystemLogger("pairing");

type PairingOwnerDeliverResult = { ok: boolean; error?: unknown };

type PairingOwnerDeliver = (params: {
  cfg: OpenClawConfig;
  channel: string;
  to: string;
  accountId?: string;
  text: string;
}) => Promise<PairingOwnerDeliverResult>;

const defaultDeliver: PairingOwnerDeliver = async (params) => {
  const { sendDurableMessageBatchCore } = await import("../channels/message/runtime.js");
  const send = await sendDurableMessageBatchCore({
    cfg: params.cfg,
    channel: params.channel,
    to: params.to,
    ...(params.accountId ? { accountId: params.accountId } : {}),
    payloads: [{ text: params.text }],
  });
  return send.status === "failed" || send.status === "partial_failed"
    ? { ok: false, error: send.error }
    : { ok: true };
};

function concreteEntries(entries: Array<string | number> | null | undefined): string[] {
  return (entries ?? [])
    .map((entry) => String(entry).trim())
    .filter((entry) => entry && entry !== "*" && !entry.endsWith(":*"));
}

/**
 * An `ownerAllowFrom` entry such as `telegram:123456789` scopes to one
 * channel; an unprefixed entry (e.g. a bare Slack user id) applies to any
 * channel. Splits and matches on the literal channel id, matching the
 * documented `docs/channels/pairing.md` convention.
 */
function matchesConfiguredOwnerChannel(entry: string, channel: string): boolean {
  const colon = entry.indexOf(":");
  if (colon < 0) {
    return true;
  }
  return entry.slice(0, colon).toLowerCase() === channel.toLowerCase();
}

function stripConfiguredOwnerChannelPrefix(entry: string, channel: string): string {
  const prefix = `${channel.toLowerCase()}:`;
  return entry.toLowerCase().startsWith(prefix) ? entry.slice(prefix.length).trim() : entry;
}

/**
 * Resolves who to notify about one channel account's pairing activity.
 * Prefers the gateway-wide configured owner (`commands.ownerAllowFrom`) when
 * it names this channel or is unprefixed; otherwise falls back to the
 * requested channel account's own configured DM allowlist. Returns
 * `undefined` when neither resolves to anyone -- callers must treat that as
 * "nothing more to do", not an error.
 */
export function resolvePairingOwnerTarget(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
}): { channel: string; to: string } | undefined {
  const channel = normalizeMessageChannel(params.channel) ?? params.channel;
  if (!isDeliverableMessageChannel(channel)) {
    return undefined;
  }
  const plugin = getLoadedChannelPlugin(channel);
  if (!plugin) {
    return undefined;
  }
  const configuredOwner = concreteEntries(params.cfg.commands?.ownerAllowFrom).find((entry) =>
    matchesConfiguredOwnerChannel(entry, channel),
  );
  if (configuredOwner) {
    return { channel, to: stripConfiguredOwnerChannelPrefix(configuredOwner, channel) };
  }
  // Tenant isolation: only this exact account's own allowlist is consulted,
  // never another account's, and never a different channel's default account.
  const accountOwner = concreteEntries(
    plugin.config.resolveAllowFrom?.({ cfg: params.cfg, accountId: params.accountId }),
  )[0];
  return accountOwner ? { channel, to: accountOwner } : undefined;
}

function describePairingAccount(params: { channel: string; accountId?: string }): string {
  return params.accountId ? `${params.channel}:${params.accountId}` : params.channel;
}

function buildRequestedOwnerText(notice: ChannelPairingRequestedNotice): string {
  return (
    `DM access requested on ${describePairingAccount(notice)} by ${notice.senderId}. Nobody has ` +
    `access until you approve it. Review with: ${formatPairingListHint(notice)}`
  );
}

export function buildStalePairingOwnerText(params: {
  channel: string;
  accountId?: string;
  senderId: string;
  ageLabel: string;
}): string {
  return (
    `DM access request unanswered for ${params.ageLabel} on ${describePairingAccount(params)} ` +
    `from ${params.senderId}. Approve or dismiss it: ${formatPairingListHint(params)}`
  );
}

export type PairingOwnerNotifyDeps = {
  getConfig?: () => OpenClawConfig;
  deliver?: PairingOwnerDeliver;
  resolveTarget?: typeof resolvePairingOwnerTarget;
};

export type PairingOwnerNotifyResult = { sent: boolean; reason?: string };

async function deliverPairingOwnerNotice(params: {
  channel: string;
  accountId?: string;
  text: string;
  deps: PairingOwnerNotifyDeps;
}): Promise<PairingOwnerNotifyResult> {
  const getConfig = params.deps.getConfig ?? getRuntimeConfig;
  const deliver = params.deps.deliver ?? defaultDeliver;
  const resolveTarget = params.deps.resolveTarget ?? resolvePairingOwnerTarget;
  const account = describePairingAccount(params);
  try {
    const cfg = getConfig();
    const target = resolveTarget({ cfg, channel: params.channel, accountId: params.accountId });
    if (!target) {
      return { sent: false, reason: "no-owner-route" };
    }
    const result = await deliver({
      cfg,
      channel: target.channel,
      to: target.to,
      ...(params.accountId ? { accountId: params.accountId } : {}),
      text: params.text,
    });
    if (!result.ok) {
      log.warn(`pairing owner notice failed for ${account}: ${String(result.error)}`);
      return { sent: false, reason: "delivery-failed" };
    }
    return { sent: true };
  } catch (err) {
    log.warn(`pairing owner notice failed for ${account}: ${String(err)}`);
    return { sent: false, reason: "error" };
  }
}

/**
 * Notifies the resolved owner that a new DM access request arrived.
 * Best-effort and never throws: the pairing subsystem log line this
 * augments does not depend on it, and neither should the request being
 * visible in `openclaw pairing list`.
 */
export async function notifyPairingRequestedOwner(
  notice: ChannelPairingRequestedNotice,
  deps: PairingOwnerNotifyDeps = {},
): Promise<PairingOwnerNotifyResult> {
  return deliverPairingOwnerNotice({
    channel: notice.channel,
    ...(notice.accountId ? { accountId: notice.accountId } : {}),
    text: buildRequestedOwnerText(notice),
    deps,
  });
}

/** Notifies the resolved owner about one stale request. Best-effort; never throws. */
export async function notifyPairingStaleOwner(
  params: { channel: string; accountId?: string; senderId: string; ageLabel: string },
  deps: PairingOwnerNotifyDeps = {},
): Promise<PairingOwnerNotifyResult> {
  return deliverPairingOwnerNotice({
    channel: params.channel,
    ...(params.accountId ? { accountId: params.accountId } : {}),
    text: buildStalePairingOwnerText(params),
    deps,
  });
}

/**
 * Wires the core arrival notice to also reach a human directly, not only the
 * pairing subsystem log. Gateway startup calls this once, alongside the
 * staleness sweep. A plugin subscribed to `channel_pairing_requested`
 * remains a separate, optional path; this does not replace it.
 */
export function registerPairingOwnerRequestNotifications(
  deps: PairingOwnerNotifyDeps = {},
): () => void {
  return onChannelPairingRequested((notice) => {
    void notifyPairingRequestedOwner(notice, deps);
  });
}
