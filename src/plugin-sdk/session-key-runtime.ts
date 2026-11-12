/**
 * Runtime SDK subpath for classifying session keys and parsing transcript identities.
 */
export {
  isIncognitoSessionKey,
  resolveAgentIdFromSessionKey,
  type ParsedAgentSessionKey,
} from "../routing/session-key.js";
export {
  isCronRunSessionKey,
  isDreamingNarrativeSessionStoreKey,
} from "../sessions/session-key-utils.js";
export { isShadowHookSessionKey } from "../infra/hook-requester-attestation.js";
export {
  lookupShadowRequesterIdentity,
  registerShadowRequesterIdentity,
} from "../infra/shadow-requester-identity.js";
export { parseUsageCountedSessionIdFromFileName } from "../config/sessions/artifacts.js";
