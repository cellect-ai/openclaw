import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";

const SessionKeySchema = Type.String({ minLength: 1, maxLength: 1_024 });

/**
 * Operator request to report one shadow turn into a cellect-fi-user Matrix room.
 * `roomId` is the room. `threadId` is the optional thread root inside that room.
 * `ownerEmail` must equal the member Fi already resolved for `childSessionKey`.
 */
export const FiShadowAnnounceParamsSchema = closedObject({
  roomId: Type.String({ minLength: 1, maxLength: 255 }),
  threadId: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  ownerEmail: Type.String({ minLength: 3, maxLength: 254 }),
  childSessionKey: SessionKeySchema,
  idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
  label: Type.String({ minLength: 1, maxLength: 80 }),
  resultText: Type.String({ maxLength: 4_000 }),
  replyInstruction: Type.Union([Type.Literal("decide"), Type.Literal("ask_owner")]),
});

export const FiShadowAnnounceResultSchema = closedObject({
  path: Type.Union([Type.Literal("steered"), Type.Literal("direct"), Type.Literal("none")]),
  deliveredAt: Type.Optional(Type.Number()),
});

export type FiShadowAnnounceParams = Static<typeof FiShadowAnnounceParamsSchema>;
export type FiShadowAnnounceResult = Static<typeof FiShadowAnnounceResultSchema>;
