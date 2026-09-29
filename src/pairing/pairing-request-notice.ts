// Core subscriber for channel pairing requests, so one is never silent.
//
// `channel_pairing_requested` is a plugin hook, and a plugin hook with no
// plugin subscribed runs nothing: an outsider asking for access produced no
// log line, no alert and no trace anywhere in the gateway. A plugin is an
// optional extension of this notice, not the thing that makes a request
// visible, so the notice lives in core and always runs.
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSet } from "../shared/global-singleton.js";

export type ChannelPairingRequestedNotice = {
  channel: string;
  accountId?: string;
  senderId: string;
  /** Sender-supplied channel metadata. Untrusted; never widened into a decision. */
  metadata?: Record<string, string | undefined>;
};

export type ChannelPairingRequestedListener = (notice: ChannelPairingRequestedNotice) => void;

// Process-global so a second module copy (plugin-sdk re-export, extension
// bundle) reaches the same listeners instead of silently keeping its own set.
const listeners = resolveGlobalSet<ChannelPairingRequestedListener>(
  Symbol.for("openclaw.pairing.requestedListeners"),
  "close-and-restart",
);

/**
 * Adds a core listener for new pairing requests. Returns a disposer.
 * Gateway-side surfaces attach here; the plugin hook stays the extension path.
 */
export function onChannelPairingRequested(listener: ChannelPairingRequestedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Clears registered listeners. Tests only. */
export function resetChannelPairingRequestedListeners(): void {
  listeners.clear();
}

function describePairingAccount(notice: ChannelPairingRequestedNotice): string {
  return notice.accountId ? `${notice.channel}:${notice.accountId}` : notice.channel;
}

/** The operator-facing hint that turns the log line into an action. */
export function formatPairingListHint(notice: ChannelPairingRequestedNotice): string {
  const account = notice.accountId ? ` --account ${notice.accountId}` : "";
  return `openclaw pairing list --channel ${notice.channel}${account}`;
}

/**
 * Records a new pairing request. The pairing code stays out of the log: it is
 * the secret the sender and the approver share, and `pairing list` is the
 * surface that hands it to an operator who can already read the store.
 */
export function recordChannelPairingRequested(notice: ChannelPairingRequestedNotice): void {
  const log = createSubsystemLogger("pairing");
  log.warn(
    `DM access requested on ${describePairingAccount(notice)} by ${notice.senderId}; ` +
      `nobody has access until this is approved. Review with: ${formatPairingListHint(notice)}`,
  );
  for (const listener of listeners) {
    try {
      listener(notice);
    } catch (err) {
      log.warn(`pairing request listener failed: ${String(err)}`);
    }
  }
}
