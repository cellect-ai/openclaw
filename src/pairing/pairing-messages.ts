// Formats pairing challenge replies and setup instructions.
import { formatCliCommand } from "../cli/command-format.js";
import type { PairingChannel } from "./pairing-store.types.js";

// User-facing pairing reply formatter sent to unapproved channel users. The
// owner command is formatted through CLI helpers so profiles/aliases stay valid.
export function buildPairingReply(params: {
  channel: PairingChannel;
  idLine: string;
  code: string;
}): string {
  const { channel, idLine, code } = params;
  const approveCommand = formatCliCommand(`openclaw pairing approve ${channel} ${code}`);
  return [
    "OpenClaw: access not configured.",
    "",
    idLine,
    "Pairing code:",
    "```",
    code,
    "```",
    "",
    "Ask the bot owner to approve with:",
    "```",
    approveCommand,
    "```",
  ].join("\n");
}

// Reminder sent when an unapproved sender writes again while their pairing
// request is still pending. Deliberately worded differently from the first-time
// challenge so a repeat sender can tell nothing new is required from them.
export function buildPairingReminderReply(params: {
  channel: PairingChannel;
  idLine: string;
  code: string;
}): string {
  const { channel, idLine, code } = params;
  const approveCommand = formatCliCommand(`openclaw pairing approve ${channel} ${code}`);
  return [
    "OpenClaw: your access request is still waiting for approval.",
    "",
    idLine,
    "Pairing code:",
    "```",
    code,
    "```",
    "",
    "Nothing more is needed from you. The bot owner approves with:",
    "```",
    approveCommand,
    "```",
  ].join("\n");
}
