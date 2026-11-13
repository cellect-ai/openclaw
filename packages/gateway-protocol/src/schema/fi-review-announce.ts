import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";

/** Fi supplies an accepted report; destination and owner come only from current Fi enrollment. */
export const FiReviewAnnounceParamsSchema = closedObject({
  reviewAttestation: Type.String({ minLength: 1, maxLength: 256 }),
  childSessionKey: Type.String({ minLength: 1, maxLength: 250 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
  label: Type.String({ minLength: 1, maxLength: 80 }),
  resultText: Type.String({ minLength: 1, maxLength: 4000 }),
});
export type FiReviewAnnounceParams = Static<typeof FiReviewAnnounceParamsSchema>;
