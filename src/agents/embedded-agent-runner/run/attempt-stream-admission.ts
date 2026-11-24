import { type EmbeddedAttemptSteeringAdmission } from "./attempt-steering-admission.js";
import type { PrepareEmbeddedAttemptStreamInput } from "./attempt-stream-prepare.types.js";

export function isEmbeddedAttemptSteeringOpen(
  input: PrepareEmbeddedAttemptStreamInput,
  admission: EmbeddedAttemptSteeringAdmission,
): boolean {
  const state = input.getRunState();
  return (
    admission.accepting &&
    !state.aborted &&
    !state.yieldDetected &&
    !input.runAbortController.signal.aborted
  );
}
