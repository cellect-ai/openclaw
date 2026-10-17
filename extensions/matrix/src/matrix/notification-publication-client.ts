import { createHash } from "node:crypto";

/** Frozen host publication references, never a caller-selected delivery route. */
export type NotificationPublicationScope = {
  environment: string;
  publication_id: string;
  room_id: string;
  conversation_id: string;
  binding_id: string;
  run_id: string;
  generation: string;
  provider: "slack";
  source_account_id: string;
  source_workspace_id: string;
  source_conversation_id: string;
  source_root_message_id: string;
  published_at_ms: number;
};
export type NotificationPublicationPrepared = {
  publicationId: string;
  prepared: boolean;
  recipientKey?: string;
  reservedRoute: "unknown" | "mobile" | "origin";
  originPermit: boolean;
};
export type NotificationPublicationClient =
  | { status: "disabled" | "invalid" }
  | {
      status: "ready";
      prepare(
        scope: NotificationPublicationScope,
        sourceActorId: string,
      ): Promise<NotificationPublicationPrepared>;
      accepted(
        scope: NotificationPublicationScope,
        sourceMessageId: string,
        resultEventId: string,
      ): Promise<void>;
    };

const MAX_RESPONSE_BYTES = 16 * 1024;
const reference = (value: unknown): value is string =>
  typeof value === "string" && /^[\x21-\x7e]{1,512}$/.test(value);
const slackId = (value: unknown, prefix: string): value is string =>
  typeof value === "string" && new RegExp(`^[${prefix}][A-Z0-9]{8,20}$`).test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const failure = () => new Error("notification publication evidence unavailable");

function snapshot(scope: NotificationPublicationScope): NotificationPublicationScope {
  // Explicit fields keep unexpected caller properties out of the private API.
  const frozen: NotificationPublicationScope = {
    environment: scope.environment,
    publication_id: scope.publication_id,
    room_id: scope.room_id,
    conversation_id: scope.conversation_id,
    binding_id: scope.binding_id,
    run_id: scope.run_id,
    generation: scope.generation,
    provider: scope.provider,
    source_account_id: scope.source_account_id,
    source_workspace_id: scope.source_workspace_id,
    source_conversation_id: scope.source_conversation_id,
    source_root_message_id: scope.source_root_message_id,
    published_at_ms: scope.published_at_ms,
  };
  if (
    Object.entries(frozen).some(([key, value]) => key !== "published_at_ms" && !reference(value)) ||
    frozen.provider !== "slack" ||
    !frozen.room_id.startsWith("!") ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(frozen.publication_id) ||
    frozen.publication_id === "00000000-0000-0000-0000-000000000000" ||
    !slackId(frozen.source_workspace_id, "T") ||
    !slackId(frozen.source_conversation_id, "CDG") ||
    !Number.isSafeInteger(frozen.published_at_ms) ||
    frozen.published_at_ms < 1_000_000_000_000 ||
    frozen.published_at_ms >= 10_000_000_000_000
  ) {
    throw failure();
  }
  return Object.freeze(frozen);
}

async function boundedJson(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    throw failure();
  }
  if (!response.body) {
    throw failure();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        throw failure();
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

/** Dedicated producer capability; registry credentials never enable this path. */
export function resolveNotificationPublicationClient(
  env: NodeJS.ProcessEnv = process.env,
  options: { fetchImpl?: typeof fetch } = {},
): NotificationPublicationClient {
  const rawUrl = env.PROJECTOR_NOTIFICATION_PRODUCER_URL?.trim() ?? "";
  const bearer = env.PROJECTOR_NOTIFICATION_PRODUCER_BEARER?.trim() ?? "";
  if (!rawUrl && !bearer) {
    return { status: "disabled" };
  }
  let base: URL;
  try {
    base = new URL(rawUrl);
  } catch {
    return { status: "invalid" };
  }
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.href.includes("?") ||
    base.href.includes("#") ||
    !/^[\x21-\x7e]{32,256}$/.test(bearer) ||
    [
      env.PROJECTOR_REGISTRY_WRITER_BEARER,
      env.PROJECTOR_REGISTRY_READER_BEARER,
      env.PROJECTOR_SERVICE_BEARER,
      env.PROJECTOR_NOTIFICATION_ADAPTER_BEARER,
    ].some((other) => other?.trim() === bearer)
  ) {
    return { status: "invalid" };
  }
  const url = base.toString().replace(/\/+$/, "");
  async function post(endpoint: "prepare" | "accepted", body: unknown): Promise<unknown> {
    try {
      const response = await (options.fetchImpl ?? fetch)(
        `${url}/v2/notification-publications/${endpoint}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(3_000),
        },
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw failure();
      }
      return await boundedJson(response);
    } catch {
      throw failure();
    }
  }
  return {
    status: "ready",
    async prepare(scope, sourceActorId) {
      const frozen = snapshot(scope);
      if (!slackId(sourceActorId, "UW")) {
        throw failure();
      }
      const expectedKey = createHash("sha256")
        .update(JSON.stringify(["slack", frozen.source_workspace_id, sourceActorId]))
        .digest("hex");
      const result = await post("prepare", { scope: frozen, source_actor_id: sourceActorId });
      if (
        !record(result) ||
        result.publicationId !== frozen.publication_id ||
        typeof result.prepared !== "boolean" ||
        typeof result.originPermit !== "boolean" ||
        (result.reservedRoute !== "unknown" &&
          result.reservedRoute !== "mobile" &&
          result.reservedRoute !== "origin") ||
        (result.recipientKey !== undefined && result.recipientKey !== expectedKey) ||
        (result.prepared && result.recipientKey !== expectedKey) ||
        (!result.prepared && (result.reservedRoute !== "unknown" || result.originPermit)) ||
        (result.originPermit && result.reservedRoute !== "origin")
      ) {
        throw failure();
      }
      return {
        publicationId: frozen.publication_id,
        prepared: result.prepared,
        ...(result.recipientKey === expectedKey ? { recipientKey: expectedKey } : {}),
        reservedRoute: result.reservedRoute,
        originPermit: result.originPermit,
      };
    },
    async accepted(scope, sourceMessageId, resultEventId) {
      const frozen = snapshot(scope);
      if (
        !reference(sourceMessageId) ||
        !reference(resultEventId) ||
        !resultEventId.startsWith("$")
      ) {
        throw failure();
      }
      const result = await post("accepted", {
        scope: frozen,
        source_message_id: sourceMessageId,
        result_event_id: resultEventId,
      });
      if (
        !record(result) ||
        result.publicationId !== frozen.publication_id ||
        result.resultEventId !== resultEventId ||
        result.accepted !== true
      ) {
        throw failure();
      }
    },
  };
}
