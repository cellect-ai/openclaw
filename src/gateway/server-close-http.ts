import type { Server as HttpServer } from "node:http";
import { hasErrnoCode } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { settlesWithin } from "../shared/settle-within.js";
import {
  recordGatewayShutdownWarning as recordShutdownWarning,
  GatewayShutdownCleanupRetainedError,
} from "./server-shutdown.js";

export const shutdownLog = createSubsystemLogger("gateway/shutdown");

export const HTTP_CLOSE_GRACE_MS = 1_000;

export const HTTP_CLOSE_FORCE_WAIT_MS = 5_000;

async function waitForHttpClose(params: {
  closePromise: Promise<void>;
  timeoutMs: number;
  label: string;
  warnings: string[];
}): Promise<boolean> {
  return await settlesWithin(params.closePromise, params.timeoutMs).catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    shutdownLog.warn(`${params.label}: ${detail}`);
    recordShutdownWarning(params.warnings, params.label);
    return true;
  });
}

export async function closeHttpListener(params: {
  server: HttpServer;
  label: string;
  warnings: string[];
}): Promise<void> {
  const { server, label, warnings } = params;
  server.closeIdleConnections?.();
  const closePromise = new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (!err || hasErrnoCode(err, "ERR_SERVER_NOT_RUNNING")) {
        resolve();
        return;
      }
      reject(err);
    });
  });
  void closePromise.catch(() => undefined);
  const closedWithinGrace = await waitForHttpClose({
    closePromise,
    timeoutMs: HTTP_CLOSE_GRACE_MS,
    label,
    warnings,
  });
  if (closedWithinGrace) {
    return;
  }
  shutdownLog.warn(
    `${label} close exceeded ${HTTP_CLOSE_GRACE_MS}ms; forcing connection shutdown and waiting for close`,
  );
  recordShutdownWarning(warnings, label);
  server.closeAllConnections?.();
  const closedAfterForce = await waitForHttpClose({
    closePromise,
    timeoutMs: HTTP_CLOSE_FORCE_WAIT_MS,
    label,
    warnings,
  });
  if (!closedAfterForce) {
    throw new GatewayShutdownCleanupRetainedError(
      [],
      `${label} close still pending after forced connection shutdown (${HTTP_CLOSE_FORCE_WAIT_MS}ms)`,
    );
  }
}
