// Gateway WebSocket device proof binds the signed identity to the connect request.
import { resolveDeviceAuthConnectErrorDetailCode } from "../../../../packages/gateway-protocol/src/connect-error-details.js";
import { ErrorCodes, errorShape } from "../../../../packages/gateway-protocol/src/index.js";
import {
  deriveDeviceIdFromPublicKey,
  normalizeDevicePublicKeyBase64Url,
} from "../../../infra/device-identity.js";
import type { GatewayAuthResult, ResolvedGatewayAuth } from "../../auth.js";
import type { GatewayRole } from "../../role-policy.types.js";
import { emitGatewayAuthSecurityEvent } from "./connect-auth-security.js";
import { resolveDeviceSignaturePayloadVersion } from "./handshake-auth-helpers.js";
import type { GatewayConnectPhaseContext } from "./message-handler-types.js";

const DEVICE_SIGNATURE_SKEW_MS = 2 * 60 * 1000;

type ConnectDevice = NonNullable<GatewayConnectPhaseContext["connectParams"]["device"]>;

export type GatewayConnectDeviceProofCheck =
  | { ok: true; devicePublicKey: string; deviceAuthPayloadVersion: "v2" | "v3" }
  | { ok: false; reason: string; message: string };

/**
 * Side-effect-free device proof check: the id derives from the public key, the
 * signature is fresh, bound to this connection's nonce, and valid for the
 * requested client, role, scopes and presented token.
 */
export function checkGatewayConnectDeviceProof(
  context: GatewayConnectPhaseContext,
  params: { device: ConnectDevice; role: GatewayRole; scopes: string[] },
): GatewayConnectDeviceProofCheck {
  const { device, role, scopes } = params;
  const { connectParams } = context;
  const derivedId = deriveDeviceIdFromPublicKey(device.publicKey);
  if (!derivedId || derivedId !== device.id) {
    return { ok: false, reason: "device-id-mismatch", message: "device identity mismatch" };
  }
  const signedAt = device.signedAt;
  if (typeof signedAt !== "number" || Math.abs(Date.now() - signedAt) > DEVICE_SIGNATURE_SKEW_MS) {
    return { ok: false, reason: "device-signature-stale", message: "device signature expired" };
  }
  const providedNonce = typeof device.nonce === "string" ? device.nonce.trim() : "";
  if (!providedNonce) {
    return { ok: false, reason: "device-nonce-missing", message: "device nonce required" };
  }
  if (providedNonce !== context.handler.connectNonce) {
    return { ok: false, reason: "device-nonce-mismatch", message: "device nonce mismatch" };
  }
  const payloadVersion = resolveDeviceSignaturePayloadVersion({
    device,
    connectParams,
    role,
    scopes,
    signedAtMs: signedAt,
    nonce: providedNonce,
  });
  if (!payloadVersion) {
    return { ok: false, reason: "device-signature", message: "device signature invalid" };
  }
  const devicePublicKey = normalizeDevicePublicKeyBase64Url(device.publicKey);
  if (!devicePublicKey) {
    return { ok: false, reason: "device-public-key", message: "device public key invalid" };
  }
  return { ok: true, devicePublicKey, deviceAuthPayloadVersion: payloadVersion };
}

export function verifyGatewayConnectDeviceProof(
  context: GatewayConnectPhaseContext,
  params: {
    device: GatewayConnectPhaseContext["connectParams"]["device"] | null | undefined;
    resolvedAuth: ResolvedGatewayAuth;
    authMethod: GatewayAuthResult["method"];
    role: GatewayRole;
    scopes: string[];
  },
):
  | { ok: true; devicePublicKey: string | null; deviceAuthPayloadVersion: "v2" | "v3" | null }
  | { ok: false } {
  const { device, resolvedAuth, authMethod, role, scopes } = params;
  if (!device) {
    return { ok: true, devicePublicKey: null, deviceAuthPayloadVersion: null };
  }
  const { frame, connectParams } = context;
  const { send, close, setHandshakeState, setCloseCause } = context.handler;
  const proof = checkGatewayConnectDeviceProof(context, { device, role, scopes });
  if (proof.ok) {
    return {
      ok: true,
      devicePublicKey: proof.devicePublicKey,
      deviceAuthPayloadVersion: proof.deviceAuthPayloadVersion,
    };
  }
  const { reason, message } = proof;
  emitGatewayAuthSecurityEvent({
    action: "gateway.auth.failed",
    outcome: "denied",
    severity: "medium",
    authMode: resolvedAuth.mode,
    authMethod,
    authProvided: "device-signature",
    role,
    scopes,
    clientMode: connectParams.client.mode,
    deviceId: device.id,
    reason,
  });
  setHandshakeState("failed");
  setCloseCause("device-auth-invalid", {
    reason,
    client: connectParams.client.id,
    deviceId: device.id,
  });
  send({
    type: "res",
    id: frame.id,
    ok: false,
    error: errorShape(ErrorCodes.INVALID_REQUEST, message, {
      details: { code: resolveDeviceAuthConnectErrorDetailCode(reason), reason },
    }),
  });
  close(1008, message);
  return { ok: false };
}
