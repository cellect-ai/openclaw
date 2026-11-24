import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
// Gateway Protocol schemas for cooperative host suspension.
import { stringLiteralUnion } from "./string-literal-union.js";

const SuspensionTokenSchema = Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" });
const CountSchema = Type.Integer({ minimum: 0 });
const GatewaySuspendTargetSchema = closedObject({
  pid: Type.Integer({ minimum: 1 }),
  processInstanceId: SuspensionTokenSchema,
});
const GatewaySuspendProcessIdentity = {
  pid: Type.Optional(Type.Integer({ minimum: 1 })),
  processInstanceId: Type.Optional(SuspensionTokenSchema),
};

/** Recorded lifecycle sections; absence on older residents means unknown custody. */
const GatewayWriteCustodySchema = Type.Array(
  closedObject({
    phase: Type.String({ minLength: 1 }),
    count: CountSchema,
  }),
);
export type GatewayWriteCustody = Static<typeof GatewayWriteCustodySchema>;

/** Public admission state only; never includes the controller's suspension token. */
export const GatewaySuspensionSchema = closedObject({
  phase: stringLiteralUnion(["accepting", "preparing", "draining", "prepared"]),
});
export type GatewaySuspension = Static<typeof GatewaySuspensionSchema>;

export const GatewaySuspendBlockerSchema = closedObject({
  kind: stringLiteralUnion([
    "queue",
    "reply",
    "embedded-run",
    "background-exec",
    "cron-run",
    "agent-run",
    "acp-run",
    "media-generation",
    "root-request",
    "session-admission",
    "session-mutation",
    "chat-run",
    "queued-turn",
    "terminal-persistence",
    "terminal-session",
  ]),
  count: CountSchema,
  message: Type.String(),
});

export const GatewaySuspendPrepareParamsSchema = closedObject({
  requestId: SuspensionTokenSchema,
  terminalPolicy: Type.Optional(stringLiteralUnion(["preserve", "terminate"])),
  drain: Type.Optional(Type.Boolean()),
  target: Type.Optional(GatewaySuspendTargetSchema),
});

export const GatewaySuspendPrepareBusyResultSchema = closedObject({
  status: Type.Literal("busy"),
  reason: stringLiteralUnion(["active-work", "gateway-draining"]),
  retryAfterMs: CountSchema,
  activeCount: CountSchema,
  blockers: Type.Array(GatewaySuspendBlockerSchema),
  writeCustody: Type.Optional(GatewayWriteCustodySchema),
});

export const GatewaySuspendPrepareDrainingResultSchema = closedObject({
  status: Type.Literal("draining"),
  suspensionId: SuspensionTokenSchema,
  expiresAtMs: CountSchema,
  retryAfterMs: CountSchema,
  activeCount: CountSchema,
  blockers: Type.Array(GatewaySuspendBlockerSchema),
  writeCustody: Type.Optional(GatewayWriteCustodySchema),
});

export const GatewaySuspendPrepareReadyResultSchema = closedObject({
  status: Type.Literal("ready"),
  suspensionId: SuspensionTokenSchema,
  expiresAtMs: CountSchema,
  activeCount: CountSchema,
  blockers: Type.Array(GatewaySuspendBlockerSchema),
  writeCustody: Type.Optional(GatewayWriteCustodySchema),
});

export const GatewaySuspendPrepareResultSchema = Type.Union([
  GatewaySuspendPrepareBusyResultSchema,
  GatewaySuspendPrepareDrainingResultSchema,
  GatewaySuspendPrepareReadyResultSchema,
]);

export const GatewaySuspendStatusParamsSchema = closedObject({
  suspensionId: SuspensionTokenSchema,
  includeLifecycle: Type.Optional(Type.Boolean()),
});

export const GatewaySuspendStatusRunningResultSchema = closedObject({
  status: Type.Literal("running"),
  ...GatewaySuspendProcessIdentity,
});

export const GatewaySuspendStatusDrainingResultSchema = closedObject({
  status: Type.Literal("draining"),
  ...GatewaySuspendProcessIdentity,
  ownerId: Type.Optional(SuspensionTokenSchema),
  phase: Type.Optional(stringLiteralUnion(["draining", "interrupting", "exiting"])),
  expiresAtMs: CountSchema,
  retryAfterMs: CountSchema,
  activeCount: CountSchema,
  blockers: Type.Array(GatewaySuspendBlockerSchema),
  writeCustody: Type.Optional(GatewayWriteCustodySchema),
});

export const GatewaySuspendStatusReadyResultSchema = closedObject({
  status: Type.Literal("ready"),
  ...GatewaySuspendProcessIdentity,
  ownerId: Type.Optional(SuspensionTokenSchema),
  expiresAtMs: CountSchema,
  writeCustody: Type.Optional(GatewayWriteCustodySchema),
});

export const GatewaySuspendStatusResultSchema = Type.Union([
  GatewaySuspendStatusRunningResultSchema,
  GatewaySuspendStatusDrainingResultSchema,
  GatewaySuspendStatusReadyResultSchema,
]);

export const GatewaySuspendResumeParamsSchema = closedObject({
  suspensionId: SuspensionTokenSchema,
});

export const GatewaySuspendResumeResultSchema = closedObject({
  ok: Type.Literal(true),
  status: Type.Literal("running"),
  resumed: Type.Boolean(),
});

/** Arms cleanup, or commits the exact host's shutdown before external native stop. */
export const GatewaySuspendHandoffParamsSchema = closedObject({
  suspensionId: SuspensionTokenSchema,
  commit: Type.Optional(Type.Literal(true)),
  /** Refuse interruption if any native work appeared after the last READY observation. */
  requireIdle: Type.Optional(Type.Literal(true)),
  target: GatewaySuspendTargetSchema,
});

export const GatewaySuspendHandoffResultSchema = Type.Union([
  closedObject({
    status: stringLiteralUnion(["armed", "committed"]),
    suspensionId: SuspensionTokenSchema,
    expiresAtMs: CountSchema,
  }),
  /** Definite noncommit, unlike an RPC transport failure with an unknown outcome. */
  closedObject({
    status: Type.Literal("busy"),
    suspensionId: SuspensionTokenSchema,
    expiresAtMs: CountSchema,
    reason: stringLiteralUnion(["active-work", "write-custody"]),
  }),
]);

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type GatewaySuspendBlocker = Static<typeof GatewaySuspendBlockerSchema>;
export type GatewaySuspendPrepareParams = Static<typeof GatewaySuspendPrepareParamsSchema>;
export type GatewaySuspendPrepareResult = Static<typeof GatewaySuspendPrepareResultSchema>;
export type GatewaySuspendStatusParams = Static<typeof GatewaySuspendStatusParamsSchema>;
export type GatewaySuspendStatusResult = Static<typeof GatewaySuspendStatusResultSchema>;
export type GatewaySuspendResumeParams = Static<typeof GatewaySuspendResumeParamsSchema>;
export type GatewaySuspendResumeResult = Static<typeof GatewaySuspendResumeResultSchema>;
export type GatewaySuspendHandoffParams = Static<typeof GatewaySuspendHandoffParamsSchema>;
export type GatewaySuspendHandoffResult = Static<typeof GatewaySuspendHandoffResultSchema>;
