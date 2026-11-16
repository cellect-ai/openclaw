/**
 * The Fi environment an authenticated `/hooks/agent` request named, for one
 * run. A gateway serving several Fi environments answers every Fi call of that
 * run from `matrixEnvironments[environment]` only; it is host context, never a
 * tool or request body, and follows the same run/session custody as the mail
 * receipt. A run without an entry keeps the plugin's default Fi.
 */
import type { Result } from "@openclaw/normalization-core/result";
import { normalizeHookRequesterAttestation } from "./hook-requester-attestation.js";

export type HookFiEnvironment = "dev" | "staging" | "prod";

const ENVIRONMENTS = new Set(["dev", "staging", "prod"]);
const active = new Map<string, { sessionKey: string; environment: HookFiEnvironment }>();

export function isHookFiEnvironment(value: unknown): value is HookFiEnvironment {
  return typeof value === "string" && ENVIRONMENTS.has(value);
}

/**
 * `fiEnvironment` names the Fi that sent any hook; `requesterEnvironment`
 * (mail, RFI, CO, guest) names the same thing and must agree with it.
 */
export function normalizeHookFiEnvironment(
  payload: Record<string, unknown>,
): { ok: true; value: { fiEnvironment?: HookFiEnvironment } } | { ok: false; error: string } {
  const raw = payload.fiEnvironment;
  if (raw === undefined) {
    return { ok: true, value: {} };
  }
  if (!isHookFiEnvironment(raw)) {
    return { ok: false, error: "fiEnvironment must be dev, staging or prod" };
  }
  if (payload.requesterEnvironment !== undefined && payload.requesterEnvironment !== raw) {
    return { ok: false, error: "fiEnvironment and requesterEnvironment disagree" };
  }
  return { ok: true, value: { fiEnvironment: raw } };
}

/** The requester attestation of a hook payload together with the Fi environment it names. */
export function normalizeHookRequesterAndFiEnvironment(
  payload: Record<string, unknown>,
  sessionKey: string | undefined,
): Result<
  {
    requesterAttestation?: string;
    requesterEnvironment?: HookFiEnvironment;
    fiEnvironment?: HookFiEnvironment;
  },
  string
> {
  const requester = normalizeHookRequesterAttestation(payload, sessionKey);
  if (!requester.ok) {
    return requester;
  }
  const fi = normalizeHookFiEnvironment(payload);
  return fi.ok ? { ok: true, value: { ...requester.value, ...fi.value } } : fi;
}

/** Whether this gateway has an explicit Fi route for the environment. */
export function hasHookFiRoute(cfg: unknown, environment: HookFiEnvironment): boolean {
  const routes = (
    cfg as
      | { plugins?: { entries?: Record<string, { config?: { matrixEnvironments?: unknown } }> } }
      | undefined
  )?.plugins?.entries?.["fi-user"]?.config?.matrixEnvironments;
  if (!routes || typeof routes !== "object" || !Object.hasOwn(routes, environment)) {
    return false;
  }
  const route = (routes as Record<string, unknown>)[environment] as
    | { baseUrl?: unknown; brokerTokenEnv?: unknown }
    | undefined;
  return (
    typeof route?.baseUrl === "string" &&
    route.baseUrl.trim() !== "" &&
    typeof route.brokerTokenEnv === "string" &&
    route.brokerTokenEnv.trim() !== ""
  );
}

export function registerHookFiEnvironment(input: {
  runId: string;
  sessionKey: string;
  environment: HookFiEnvironment | undefined;
}): () => void {
  const runId = input.runId.trim();
  if (!runId || !input.sessionKey || !isHookFiEnvironment(input.environment)) {
    return () => {};
  }
  if (active.size >= 512 && !active.has(runId)) {
    throw new Error("Hook Fi environment capacity reached; refusing a new unbound run");
  }
  const entry = { sessionKey: input.sessionKey.toLowerCase(), environment: input.environment };
  active.set(runId, entry);
  return () => {
    if (active.get(runId) === entry) {
      active.delete(runId);
    }
  };
}

export function lookupHookFiEnvironment(
  runId: string | undefined,
  sessionKey: string | undefined,
): HookFiEnvironment | undefined {
  if (!runId || !sessionKey) {
    return undefined;
  }
  const entry = active.get(runId.trim());
  return entry?.sessionKey === sessionKey.toLowerCase() ? entry.environment : undefined;
}
