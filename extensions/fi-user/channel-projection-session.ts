export const CHANNEL_SESSION =
  /^agent:(cellect-fi-user|cellect-fi-admin|cellect-main):slack:channel:([cg][a-z0-9]+):thread:(\d+\.\d+)$/i;

export function isSlackChannelThreadSessionKey(sessionKey: string): boolean {
  return CHANNEL_SESSION.test(sessionKey);
}
