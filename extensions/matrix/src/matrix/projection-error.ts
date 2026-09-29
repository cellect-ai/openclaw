// Structured failures for the projection gateway methods. A caller used to see
// only a generic failure because the reason travelled in the payload, which
// gateway clients do not read on a failed response.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";

export type ProjectionFailureReason =
  | "invalid_request"
  | "readonly_required"
  | "readonly_conflict"
  | "history_policy_missing"
  | "generation_changed"
  | "snapshot_incomplete"
  | "source_auth_unavailable"
  | "ownership_changed"
  | "source_changed"
  | "session_missing"
  | "account_unavailable"
  | "registry_unavailable"
  | "internal";

export class ProjectionError extends Error {
  constructor(
    readonly reason: ProjectionFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "ProjectionError";
  }
}

export function projectionFailure(error: unknown) {
  const reason: ProjectionFailureReason =
    error instanceof ProjectionError ? error.reason : "internal";
  const message = formatErrorMessage(error);
  return {
    payload: { error: message },
    error: errorShape(
      reason === "invalid_request" ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
      message,
      { details: { reason } },
    ),
  };
}
