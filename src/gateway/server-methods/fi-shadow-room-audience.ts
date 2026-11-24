// Matrix half of Fi's requesterIsSoleHuman check.
//
// A person is a localpart that decodes, by the cellect-threads email bijection,
// to an address. Bots, projector senders, and the homeserver admin that creates
// the room do not decode, so they are not humans. The joined humans must be
// exactly the attested owner's MXID, and the cellect-fi-user account that read
// the room must itself be joined. The encoding lives here because the gateway
// cannot call Fi's provisioner or database to learn it.

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const LOCALPART = /^[a-z0-9._=/+-]+$/;
const ESCAPED = /^(?:[a-z0-9]|=[0-9a-f]{2})*$/;
const ENV_NAME = /^[a-z][a-z0-9]*$/;
const TENANT_BOT =
  /^(?:([a-z][a-z0-9]*)\.)?bot_([a-z0-9][a-z0-9-]{0,62})_([a-z0-9][a-z0-9-]{0,62})$/;
const USER_BOT = /^(?:([a-z][a-z0-9]*)\.)?(cellect-fi-user|cellect-fi)$/;
const MAX_LOCALPART_BYTES = 236;

function escapeLocalpart(raw: string): string {
  let out = "";
  for (const ch of raw.toLowerCase()) {
    const codePoint = ch.codePointAt(0) ?? 0;
    if (codePoint < 0x80) {
      const alphanumeric =
        (codePoint >= 0x61 && codePoint <= 0x7a) || (codePoint >= 0x30 && codePoint <= 0x39);
      out += alphanumeric ? ch : `=${codePoint.toString(16).padStart(2, "0")}`;
      continue;
    }
    for (const byte of Buffer.from(ch)) {
      out += `=${byte.toString(16).padStart(2, "0")}`;
    }
  }
  return out;
}

function unescapeLocalpart(escaped: string): string | undefined {
  if (!ESCAPED.test(escaped)) {
    return undefined;
  }
  const bytes: number[] = [];
  for (let index = 0; index < escaped.length;) {
    if (escaped[index] === "=") {
      bytes.push(Number.parseInt(escaped.slice(index + 1, index + 3), 16));
      index += 3;
      continue;
    }
    bytes.push(escaped.charCodeAt(index));
    index += 1;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return undefined;
  }
}

function splitMxid(mxid: string): { localpart: string; server: string } | undefined {
  if (!mxid.startsWith("@")) {
    return undefined;
  }
  const colon = mxid.indexOf(":");
  if (colon < 2 || colon === mxid.length - 1) {
    return undefined;
  }
  const localpart = mxid.slice(1, colon);
  if (!LOCALPART.test(localpart)) {
    return undefined;
  }
  return { localpart, server: mxid.slice(colon + 1) };
}

/** Email encoded into this MXID, when the localpart is a cellect-threads person. */
export function emailForMatrixUserId(mxid: string): { email: string; env: string } | undefined {
  const parts = splitMxid(mxid);
  if (!parts) {
    return undefined;
  }
  const dot = parts.localpart.indexOf(".");
  if (dot < 0) {
    const email = unescapeLocalpart(parts.localpart);
    return email ? { email, env: "prod" } : undefined;
  }
  const env = parts.localpart.slice(0, dot);
  if (!ENV_NAME.test(env) || env === "prod") {
    return undefined;
  }
  const email = unescapeLocalpart(parts.localpart.slice(dot + 1));
  return email ? { email, env } : undefined;
}

/** True when this joined member is a person identity, not a bot or server admin. */
export function isPersonMxid(mxid: string): boolean {
  return Boolean(emailForMatrixUserId(mxid)?.email.includes("@"));
}

/** Prod, or the environment prefix of this agent's own user-tier bot. */
function accountEnv(localpart: string): string | undefined {
  const tenant = TENANT_BOT.exec(localpart);
  const legacy = tenant ? undefined : USER_BOT.exec(localpart);
  const match = tenant ?? legacy;
  if (!match || match[1] === "prod") {
    return undefined;
  }
  return match[1] ?? "prod";
}

/** The owner's MXID on the homeserver and environment of the account that read the room. */
export function ownerMxidForAccount(email: string, accountUserId: string): string | undefined {
  const normalized = email.trim().toLowerCase();
  if (!EMAIL.test(normalized)) {
    return undefined;
  }
  const account = splitMxid(accountUserId);
  if (!account) {
    return undefined;
  }
  const env = accountEnv(account.localpart);
  if (!env) {
    return undefined;
  }
  const escaped = escapeLocalpart(normalized);
  const localpart = env === "prod" ? escaped : `${env}.${escaped}`;
  if (localpart.length > MAX_LOCALPART_BYTES) {
    return undefined;
  }
  return `@${localpart}:${account.server}`;
}

/**
 * Joined humans are exactly the attested owner, and this account is in the room.
 * Any other person fails the room. Members that do not decode as a person stay.
 */
export function roomAudienceAllowsOwner(params: {
  members: readonly string[];
  ownerEmail: string;
  accountUserId: string;
}): boolean {
  const ownerMxid = ownerMxidForAccount(params.ownerEmail, params.accountUserId);
  if (!ownerMxid || params.members.length === 0) {
    return false;
  }
  if (!params.members.includes(params.accountUserId)) {
    return false;
  }
  const humans = params.members.filter((member) => isPersonMxid(member));
  return humans.length === 1 && humans[0] === ownerMxid;
}
