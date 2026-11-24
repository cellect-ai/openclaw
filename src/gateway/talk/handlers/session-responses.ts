import { ErrorCodes, errorShape } from "../../../../packages/gateway-protocol/src/index.js";
import type { RespondFn } from "../../server-methods/types.js";
import { talkRequestError } from "../request-error.js";

export function respondInvalidRequest(respond: RespondFn, message: string) {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
}

export const talkSessionError = (error: unknown) => talkRequestError(error, "session");

export function respondOk(respond: RespondFn, payload: unknown = { ok: true }) {
  respond(true, payload, undefined);
}
