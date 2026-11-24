import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import { stringLiteralUnion } from "./string-literal-union.js";

export const THREAD_CONTINUATION_MAX_MEMBERS = 128;
export const ThreadContinuationIdentitySchema = closedObject({
  agentId: NonEmptyString,
  sessionKey: NonEmptyString,
  sessionId: NonEmptyString,
  lifecycleRevision: Type.Union([NonEmptyString, Type.Null()]),
});
export const ThreadContinuationMemberSchema = closedObject({
  ...ThreadContinuationIdentitySchema.properties,
  fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  status: stringLiteralUnion([
    "queued",
    "running",
    "done",
    "failed",
    "timeout",
    "interrupted",
    "killed",
    "unknown",
  ]),
  recoveryPending: Type.Boolean(),
  updatedAt: Type.Number({ minimum: 0 }),
  endedAt: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  terminalRunId: Type.Union([NonEmptyString, Type.Null()]),
});
/** An additional condition on an ordinary authorized agent request, never a grant. */
export const ThreadContinuationSnapshotSchema = closedObject({
  version: Type.Literal(1),
  gatewayInstance: NonEmptyString,
  expiresAt: Type.Number({ minimum: 0 }),
  owner: ThreadContinuationIdentitySchema,
  failedSessionKey: NonEmptyString,
  failedRunId: NonEmptyString,
  members: Type.Array(ThreadContinuationMemberSchema, {
    minItems: 1,
    maxItems: THREAD_CONTINUATION_MAX_MEMBERS,
  }),
});
export type ThreadContinuationSnapshot = Static<typeof ThreadContinuationSnapshotSchema>;
export type ThreadContinuationMember = Static<typeof ThreadContinuationMemberSchema>;
export type ThreadContinuationDescription = {
  complete: boolean;
  reason?: string;
  members: ThreadContinuationMember[];
  continuation?: ThreadContinuationSnapshot;
  originalTask?: string;
};
