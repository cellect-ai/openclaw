import { randomBytes } from "node:crypto";

export type TalkBindingCapability = {
  sessionKey: string;
  agentId: string;
  accountId: string;
  roomId: string;
  threadRootEventId: string;
  speakerMxid: string;
  expiresAt: number;
};

const TTL_MS = 60_000;
const MAX = 1024;
const records = new Map<string, TalkBindingCapability>();

export function mintTalkBindingCapability(input: Omit<TalkBindingCapability, "expiresAt">): string {
  const now = Date.now();
  for (const [key, value] of records) {
    if (value.expiresAt <= now) {
      records.delete(key);
    }
  }
  if (records.size >= MAX) {
    throw new Error("Matrix Talk binding capacity exceeded");
  }
  const token = randomBytes(32).toString("base64url");
  records.set(token, { ...input, expiresAt: now + TTL_MS });
  return token;
}

export function consumeTalkBindingCapability(token: string): TalkBindingCapability | undefined {
  const record = records.get(token);
  if (!record) {
    return undefined;
  }
  records.delete(token);
  return record.expiresAt > Date.now() ? record : undefined;
}

/** Reads a live capability without redeeming it (authorization pre-flight only). */
export function peekTalkBindingCapability(token: string): TalkBindingCapability | undefined {
  const record = records.get(token);
  return record && record.expiresAt > Date.now() ? record : undefined;
}

export const talkBindingCapabilityTesting = { clear: () => records.clear() };
