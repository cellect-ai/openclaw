// Builds and validates channel pairing challenges for first-time setup.
import { resolveGlobalDedupeCache } from "../infra/dedupe.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { buildPairingReminderReply, buildPairingReply } from "./pairing-messages.js";
import { recordChannelPairingRequested } from "./pairing-request-notice.js";

/**
 * Minimum spacing between pairing replies to the same sender. A repeat sender
 * must never be met with silence, but every message must not re-trigger a
 * challenge either, so at most one reply per sender per interval is sent.
 * Pending requests stay approvable for `CHANNEL_PAIRING_PENDING_TTL_MS`, so a
 * sender who keeps writing is answered at this spacing for as long as they do.
 */
export const PAIRING_REPLY_INTERVAL_MS = 15 * 60 * 1000;

const PAIRING_REPLY_CACHE_MAX = 500;

// Process-global so a second module copy (plugin-sdk re-export, extension
// bundle) shares the same throttle instead of doubling replies.
const pairingReplyThrottleKey = Symbol.for("openclaw.pairing.replyThrottle");

function resolvePairingReplyThrottle() {
  return resolveGlobalDedupeCache(pairingReplyThrottleKey, {
    ttlMs: PAIRING_REPLY_INTERVAL_MS,
    maxSize: PAIRING_REPLY_CACHE_MAX,
  });
}

function pairingReplyThrottleKeyFor(params: {
  channel: string;
  accountId?: string;
  senderId: string;
}): string {
  return `${params.channel}\u0000${normalizeAccountId(params.accountId)}\u0000${params.senderId}`;
}

/** Clears the reply throttle. Tests only. */
export function resetPairingReplyThrottle(): void {
  resolvePairingReplyThrottle().clear();
}

type PairingMeta = Record<string, string | undefined>;

type PairingChallengeParams = {
  channel: string;
  accountId?: string;
  senderId: string;
  senderIdLine: string;
  meta?: PairingMeta;
  upsertPairingRequest: (params: {
    id: string;
    meta?: PairingMeta;
  }) => Promise<{ code: string; created: boolean }>;
  sendPairingReply: (text: string) => Promise<void>;
  buildReplyText?: (params: { code: string; senderIdLine: string }) => string;
  onCreated?: (params: { code: string }) => void;
  /** Called when a repeat sender is reminded that their request is still pending. */
  onReminded?: (params: { code: string }) => void;
  onReplyError?: (err: unknown) => void;
};

async function announcePairingRequested(params: {
  channel: string;
  accountId?: string;
  senderId: string;
  code: string;
  meta?: PairingMeta;
}): Promise<void> {
  // The core notice runs first and unconditionally: a request must be visible
  // whether or not any plugin subscribed to the hook.
  recordChannelPairingRequested({
    channel: params.channel,
    ...(params.accountId ? { accountId: params.accountId } : {}),
    senderId: params.senderId,
    ...(params.meta ? { metadata: params.meta } : {}),
  });
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("channel_pairing_requested")) {
    return;
  }
  await hookRunner.runChannelPairingRequested(
    {
      channel: params.channel,
      accountId: params.accountId,
      senderId: params.senderId,
      code: params.code,
      metadata: params.meta,
    },
    {
      channelId: params.channel,
      accountId: params.accountId,
      senderId: params.senderId,
    },
  );
}

/**
 * Shared pairing challenge issuance for DM pairing policy pathways.
 * Ensures every channel follows the same create-if-missing + reply flow.
 */
export async function issuePairingChallenge(
  params: PairingChallengeParams,
): Promise<{ created: boolean; code?: string }> {
  const { code, created } = await params.upsertPairingRequest({
    id: params.senderId,
    meta: params.meta,
  });
  const throttle = resolvePairingReplyThrottle();
  const throttleKey = pairingReplyThrottleKeyFor({
    channel: params.channel,
    accountId: params.accountId,
    senderId: params.senderId,
  });
  if (!created) {
    // An empty code means the pending-request cap rejected this sender, so
    // there is no challenge to remind them about.
    if (!code) {
      return { created: false };
    }
    if (throttle.peek(throttleKey)) {
      return { created: false, code };
    }
    throttle.check(throttleKey);
    params.onReminded?.({ code });
    try {
      await params.sendPairingReply(
        buildPairingReminderReply({
          channel: params.channel,
          idLine: params.senderIdLine,
          code,
        }),
      );
    } catch (err) {
      params.onReplyError?.(err);
    }
    return { created: false, code };
  }
  throttle.check(throttleKey);
  params.onCreated?.({ code });
  const accountId = params.accountId ? normalizeAccountId(params.accountId) : undefined;
  // Notification/audit hooks must not delay the pairing-code reply.
  void announcePairingRequested({
    channel: params.channel,
    accountId,
    senderId: params.senderId,
    code,
    meta: params.meta,
  }).catch(() => undefined);
  const replyText =
    params.buildReplyText?.({ code, senderIdLine: params.senderIdLine }) ??
    buildPairingReply({
      channel: params.channel,
      idLine: params.senderIdLine,
      code,
    });
  try {
    await params.sendPairingReply(replyText);
  } catch (err) {
    params.onReplyError?.(err);
  }
  return { created: true, code };
}
