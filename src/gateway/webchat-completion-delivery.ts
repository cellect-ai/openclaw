// Signed completion routes let trusted web apps request a final channel reply
// without giving browser clients permission to choose an outbound destination.
import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

const CLAIM_CONTEXT = "openclaw:webchat-completion-delivery:v1";
const CLAIM_AUDIENCE = "openclaw-webchat-completion-delivery";
const MAX_CLOCK_SKEW_SECONDS = 30;

export const WEBCHAT_COMPLETION_DELIVERY_SECRET_ENV = "OPENCLAW_WEBCHAT_COMPLETION_DELIVERY_SECRET";
export const WEBCHAT_COMPLETION_DELIVERY_SLOW_MS = 60_000;
export const WEBCHAT_COMPLETION_DELIVERY_UNREAD_GRACE_MS = 60_000;

export type WebchatCompletionDeliveryRoute = {
  channel: string;
  to: string;
  accountId?: string;
};

export type WebchatCompletionDeliveryState = {
  route: WebchatCompletionDeliveryRoute;
  armedAtMs?: number;
  completedAtMs?: number;
  seenAtMs?: number;
  attemptedAtMs?: number;
};

type WebchatCompletionDeliveryClaimPayload = {
  v: 1;
  aud: typeof CLAIM_AUDIENCE;
  exp: number;
  agentId: string;
  route: WebchatCompletionDeliveryRoute;
};

export type WebchatCompletionDeliveryReason = "client-left" | "slow" | "unread";

function signature(secret: string, payload: string): string {
  return createHmac("sha256", secret)
    .update(CLAIM_CONTEXT)
    .update("\0")
    .update(payload)
    .digest("base64url");
}

function signaturesMatch(value: string, expected: string): boolean {
  const valueBytes = Buffer.from(value);
  const expectedBytes = Buffer.from(expected);
  return valueBytes.length === expectedBytes.length && timingSafeEqual(valueBytes, expectedBytes);
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized && normalized.length <= maxLength ? normalized : undefined;
}

function decodeClaimPayload(value: string): WebchatCompletionDeliveryClaimPayload | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const raw = parsed as Record<string, unknown>;
    const rawRoute = raw.route;
    if (!rawRoute || typeof rawRoute !== "object" || Array.isArray(rawRoute)) {
      return undefined;
    }
    const routeRecord = rawRoute as Record<string, unknown>;
    const agentId = boundedString(raw.agentId, 128)?.toLowerCase();
    const channel = boundedString(routeRecord.channel, 64)?.toLowerCase();
    const to = boundedString(routeRecord.to, 512);
    const accountId = boundedString(routeRecord.accountId, 128);
    if (
      raw.v !== 1 ||
      raw.aud !== CLAIM_AUDIENCE ||
      typeof raw.exp !== "number" ||
      !Number.isSafeInteger(raw.exp) ||
      !agentId ||
      !channel ||
      !to
    ) {
      return undefined;
    }
    return {
      v: 1,
      aud: CLAIM_AUDIENCE,
      exp: raw.exp,
      agentId,
      route: { channel, to, ...(accountId ? { accountId } : {}) },
    };
  } catch {
    return undefined;
  }
}

export function verifyWebchatCompletionDeliveryClaim(params: {
  claim: string | null | undefined;
  secret: string | null | undefined;
  expectedAgentId: string;
  nowMs?: number;
}): WebchatCompletionDeliveryRoute | undefined {
  const claim = params.claim?.trim();
  const secret = params.secret?.trim();
  if (!claim || !secret) {
    return undefined;
  }
  const [payloadPart, signaturePart, ...extra] = claim.split(".");
  if (!payloadPart || !signaturePart || extra.length > 0) {
    return undefined;
  }
  if (!signaturesMatch(signaturePart, signature(secret, payloadPart))) {
    return undefined;
  }
  const payload = decodeClaimPayload(payloadPart);
  const expectedAgentId = params.expectedAgentId.trim().toLowerCase();
  const nowSeconds = Math.floor((params.nowMs ?? Date.now()) / 1000);
  if (
    !payload ||
    payload.agentId !== expectedAgentId ||
    payload.exp + MAX_CLOCK_SKEW_SECONDS < nowSeconds
  ) {
    return undefined;
  }
  return payload.route;
}

export function armWebchatCompletionDelivery(
  state: WebchatCompletionDeliveryState | undefined,
  nowMs = Date.now(),
): boolean {
  if (!state || state.attemptedAtMs !== undefined || state.armedAtMs !== undefined) {
    return false;
  }
  state.armedAtMs = nowMs;
  return true;
}

export function armWebchatCompletionDeliveriesForConnection(params: {
  chatAbortControllers: Map<
    string,
    { ownerConnId?: string; webchatCompletionDelivery?: WebchatCompletionDeliveryState }
  >;
  connId: string;
  nowMs?: number;
}): number {
  let armed = 0;
  for (const entry of params.chatAbortControllers.values()) {
    if (
      entry.ownerConnId === params.connId &&
      armWebchatCompletionDelivery(entry.webchatCompletionDelivery, params.nowMs)
    ) {
      armed += 1;
    }
  }
  return armed;
}

export function resolveWebchatCompletionDeliveryReason(params: {
  state: WebchatCompletionDeliveryState | undefined;
  startedAtMs: number;
  nowMs?: number;
}): WebchatCompletionDeliveryReason | undefined {
  if (
    !params.state ||
    params.state.seenAtMs !== undefined ||
    params.state.attemptedAtMs !== undefined
  ) {
    return undefined;
  }
  if (params.state.armedAtMs !== undefined) {
    return "client-left";
  }
  const nowMs = params.nowMs ?? Date.now();
  return nowMs - params.startedAtMs >= WEBCHAT_COMPLETION_DELIVERY_SLOW_MS ? "slow" : "unread";
}
