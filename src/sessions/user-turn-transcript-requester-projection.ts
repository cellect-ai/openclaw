import { captureRequesterOrigin } from "../agents/requester-origin.js";
import type { PersistedUserTurnMessage } from "./user-turn-transcript.types.js";

// Exposed messages are projections. Only producer facts or exact accepted
// pending custody can supply identity to a fresh write.
export function projectRequesterOrigin<T extends PersistedUserTurnMessage | undefined>(
  candidate: T,
  origin: ReturnType<typeof captureRequesterOrigin>,
): T {
  if (!candidate) {
    return candidate;
  }
  const { requesterOrigin: _previousOrigin, ...metadata } = candidate["__openclaw"] ?? {};
  if (origin) {
    metadata.requesterOrigin = origin;
  }
  const next = { ...candidate };
  delete next["__openclaw"];
  if (Object.keys(metadata).length > 0) {
    next["__openclaw"] = metadata;
  }
  return next;
}
