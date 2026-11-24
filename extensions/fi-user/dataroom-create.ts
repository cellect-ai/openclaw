import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import { Type } from "typebox";
import {
  delegatedJson,
  pathSegment,
  type Delegation,
  type ResolvedPluginConfig,
} from "./fi-delegation.js";

export const roomCreationProperties = {
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
  kind: Type.Optional(stringEnum(["documents", "draw"] as const)),
  drawNumber: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  creationKey: Type.Optional(
    Type.String({
      minLength: 16,
      maxLength: 200,
      pattern: "^[A-Za-z0-9._:-]+$",
      description:
        "Stable key for this requested room. Preserve the same key and input on every retry, including after a timeout or unconfirmed response; never generate a replacement key to retry.",
    }),
  ),
};

export type RoomCreationInput = {
  name?: string;
  kind?: "documents" | "draw";
  drawNumber?: string;
  creationKey?: string;
  scopeType?: string;
  scopeId?: string;
};

type CreationContext = {
  config: ResolvedPluginConfig;
  delegation: Delegation;
  root: string;
  assertCurrent?: () => void;
};

type CreatedRoom = {
  id?: string;
  name?: string;
  scopeType?: string;
  scopeId?: string;
  kind?: string;
  status?: string;
  settings?: { drawNumber?: string; status?: string };
};

/** Fi owns creation, grants, draw-package linkage, idempotency and activation. */
export async function createRoom(ctx: CreationContext, input: RoomCreationInput) {
  const name = input.name?.trim();
  const scopeId = input.scopeId?.trim();
  const kind = input.kind ?? "documents";
  if (!input.creationKey || !/^[A-Za-z0-9._:-]{16,200}$/.test(input.creationKey)) {
    throw new Error(
      "Room creation requires a stable creationKey of 16–200 characters; reuse it with the same input on retry",
    );
  }
  if (
    !name ||
    name.length > 240 ||
    !scopeId ||
    scopeId.length > 200 ||
    /[:*?]/.test(scopeId) ||
    !["project", "company", "fund"].includes(input.scopeType ?? "") ||
    !["documents", "draw"].includes(kind)
  ) {
    throw new Error(
      "Provide a room name, exact scopeType (project/company/fund), scopeId and documents/draw kind",
    );
  }
  const drawNumber = input.drawNumber?.trim();
  if (kind === "draw" && (input.scopeType !== "project" || !drawNumber || drawNumber.length > 80)) {
    throw new Error("A draw room needs a project scope and drawNumber");
  }
  if (kind !== "draw" && input.drawNumber !== undefined) {
    throw new Error("Only draw rooms may specify drawNumber");
  }
  const body = {
    name,
    scopeType: input.scopeType,
    scopeId,
    kind,
    settings: kind === "draw" ? { drawNumber, status: "preparing", lenderName: null } : {},
  };
  ctx.assertCurrent?.();
  const result = (await delegatedJson(
    ctx.config,
    ctx.delegation,
    ctx.root,
    {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": input.creationKey },
      body: JSON.stringify(body),
    },
    "Fi room creation. If unconfirmed, retry with the same creationKey and input",
  )) as { ok?: boolean; room?: CreatedRoom };
  const matches = (room: CreatedRoom | undefined) =>
    room?.name === name &&
    room.scopeType === input.scopeType &&
    room.scopeId === scopeId &&
    room.kind === kind &&
    room.status === "active" &&
    (kind !== "draw" ||
      (room.settings?.drawNumber === drawNumber && room.settings?.status === "preparing"));
  if (result?.ok !== true || !result.room?.id || !matches(result.room)) {
    throw new Error(
      "Room creation is unconfirmed. Reconcile using the same creationKey and input; do not start another room",
    );
  }
  const roomId = pathSegment(result.room.id, "Created room id");
  const readback = (await delegatedJson(
    ctx.config,
    ctx.delegation,
    `${ctx.root}/${roomId}`,
    { method: "GET" },
    "Fi created-room readback. If unavailable, reconcile with the same creationKey and input",
  )) as { room?: CreatedRoom; roomVersion?: number };
  if (
    readback?.room?.id !== result.room.id ||
    !matches(readback.room) ||
    !Number.isSafeInteger(readback.roomVersion) ||
    (readback.roomVersion ?? 0) < 2
  ) {
    throw new Error(
      "Created room readback did not confirm its scope and active state. Keep the same creationKey and reconcile before retrying",
    );
  }
  return {
    room: readback.room,
    roomVersion: readback.roomVersion,
    creationKey: input.creationKey,
    url: `${ctx.config.baseUrl}/${encodeURIComponent(ctx.delegation.user.orgSlug)}/apps/data-rooms/${roomId}`,
  };
}
