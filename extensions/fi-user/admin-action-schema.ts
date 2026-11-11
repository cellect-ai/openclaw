import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import { Type } from "typebox";

/** The longest description or reason a request carries; longer text is refused, never cut. */
export const ADMIN_ACTION_TEXT_LIMIT = 1_000;
/**
 * The schema admits longer text so the tool, not a generic validator, answers
 * with the field and its length; this bound only caps what is accepted at all.
 */
const TEXT_ACCEPTED = 20_000;

export function createAdminActionRequestSchema<T extends string>(tasks: readonly [T, ...T[]]) {
  return Type.Object(
    {
      task: stringEnum(tasks, {
        description: tasks.join(" | "),
      }),
      project: Type.Optional(Type.String({ maxLength: 200 })),
      companyId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      requestId: Type.Optional(Type.String({ pattern: "^[A-Z0-9]{6}$" })),
      submissionId: Type.Optional(Type.Integer({ minimum: 1 })),
      currentSignerEmail: Type.Optional(Type.String({ format: "email" })),
      newSignerEmail: Type.Optional(Type.String({ format: "email" })),
      documentId: Type.Optional(Type.String({ maxLength: 200 })),
      recipientEmail: Type.Optional(Type.String({ format: "email" })),
      roomId: Type.Optional(
        Type.String({
          maxLength: 200,
          description: "restricted_filing into a data room. Omit to file into the project library.",
        }),
      ),
      destination: Type.Optional(
        stringEnum(["data_room", "project_library"] as const, {
          description:
            "restricted_filing: data_room (needs roomId) or project_library. Default: data_room when roomId is given, else project_library.",
        }),
      ),
      category: Type.Optional(
        Type.String({
          maxLength: 50,
          description: "restricted_filing to a project library: category.",
        }),
      ),
      section: Type.Optional(
        Type.String({
          maxLength: 200,
          description: "restricted_filing to a project library: section.",
        }),
      ),
      slackFileId: Type.Optional(Type.String({ pattern: "^F[A-Za-z0-9]{6,}$" })),
      description: Type.Optional(
        Type.String({
          maxLength: TEXT_ACCEPTED,
          description: `At most ${ADMIN_ACTION_TEXT_LIMIT} characters; longer text is refused, not truncated.`,
        }),
      ),
      targetType: Type.Optional(stringEnum(["org", "project", "company"] as const)),
      targetId: Type.Optional(Type.String({ maxLength: 200 })),
      reason: Type.Optional(
        Type.String({
          maxLength: TEXT_ACCEPTED,
          description: `At most ${ADMIN_ACTION_TEXT_LIMIT} characters; longer text is refused, not truncated.`,
        }),
      ),
      roomChange: Type.Optional(
        stringEnum(["members", "recipients", "public_links", "settings"] as const, {
          description:
            "room_admin: which kind of data-room change an administrator should make in Fi. Descriptive only; nothing is changed.",
        }),
      ),
      displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 180 })),
      roomName: Type.Optional(Type.String({ minLength: 1, maxLength: 180 })),
      order: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      noOrder: Type.Optional(Type.Boolean()),
      visibility: Type.Optional(stringEnum(["shared", "internal"] as const)),
      acknowledgeRestricted: Type.Optional(Type.Boolean()),
      taskIds: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 30 }),
      ),
      noTask: Type.Optional(Type.Boolean()),
      completeTaskIds: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 30 }),
      ),
      tags: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 30 }),
      ),
      highlight: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  );
}
