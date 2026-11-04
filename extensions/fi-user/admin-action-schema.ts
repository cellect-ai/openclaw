import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import { Type } from "typebox";

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
      description: Type.Optional(Type.String({ maxLength: 1_000 })),
      targetType: Type.Optional(stringEnum(["org", "project", "company"] as const)),
      targetId: Type.Optional(Type.String({ maxLength: 200 })),
      reason: Type.Optional(Type.String({ maxLength: 1_000 })),
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
