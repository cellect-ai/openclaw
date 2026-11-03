import { createHash } from "node:crypto";
import path from "node:path";
import { root } from "openclaw/plugin-sdk/file-access-runtime";
import { splitCommandArgs } from "openclaw/plugin-sdk/process-runtime";
import { brokerToken, type ResolvedPluginConfig } from "./fi-delegation.js";
import type { MatrixEntitlements } from "./matrix-entitlements.js";
import { sessionThreadId } from "./matrix-turn-origin.js";

type Turn = NonNullable<ReturnType<MatrixEntitlements["admittedOperatorCommand"]>>;
export function operationCommandFailure() {
  return {
    block: true as const,
    blockReason:
      "The native RFI upload could not verify its current requester, file and target. Nothing was run; retry from the authenticated conversation.",
  };
}

export function operationCommandArgs(command: string): string[] | undefined {
  const argv = splitCommandArgs(command);
  return argv && argv.slice(1, 5).join(" ") === "fi build rfi attach" ? argv : undefined;
}

/** A fixed CLI operation through its existing API, with no general requester credential. */
export async function requestOperationCommandReceipt(params: {
  turn: Turn;
  command: string;
  runId: string;
  toolCallId: string;
  connection: Pick<ResolvedPluginConfig, "baseUrl" | "brokerTokenEnv">;
  signal: AbortSignal;
  assertCurrent: () => void;
}): Promise<{ token: unknown; expiresAt: unknown; operationReceipt: true } | undefined> {
  const argv = operationCommandArgs(params.command);
  if (!argv) {
    return undefined;
  }
  const fileIndex = argv.indexOf("--file");
  const file = argv[fileIndex + 1];
  if (
    fileIndex < 5 ||
    argv.lastIndexOf("--file") !== fileIndex ||
    !file?.startsWith("/workspace/")
  ) {
    throw new Error("Native RFI upload requires one protected workspace file");
  }
  const { turn } = params;
  const workspaceDir = turn.workspaceDir;
  if (!workspaceDir) {
    throw new Error("Native RFI upload workspace is unavailable");
  }
  params.signal.throwIfAborted();
  params.assertCurrent();
  const boundary = await root(workspaceDir);
  const read = await boundary.read(file.slice("/workspace/".length), {
    maxBytes: 25 * 1024 * 1024,
    symlinks: "reject",
    hardlinks: "reject",
  });
  params.assertCurrent();
  params.signal.throwIfAborted();
  const token = brokerToken(params.connection);
  if (!token || !read.buffer.length) {
    throw new Error("Native RFI upload authority or file is unavailable");
  }
  const proof = {
    runId: params.runId,
    toolCallId: params.toolCallId,
    sessionKey: turn.sessionKey,
    roomId: turn.roomId,
    eventId: turn.eventId,
    threadRootEventId: sessionThreadId(turn.sessionKey),
    senderMxid: turn.senderId,
    accountId: turn.accountId,
  };
  const response = await fetch(
    `${params.connection.baseUrl.replace(/\/+$/, "")}/api/threads/agent-authorize`,
    {
      method: "POST",
      signal: params.signal,
      redirect: "error",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        roomId: turn.roomId,
        eventId: turn.eventId,
        agentId: turn.agentId,
        recheck: true,
        operationCommand: {
          operation: "build.rfi.attach",
          argv: argv.slice(1),
          file: {
            name: path.posix.basename(file),
            sha256: createHash("sha256").update(read.buffer).digest("hex"),
          },
          proof,
        },
      }),
    },
  );
  params.assertCurrent();
  params.signal.throwIfAborted();
  if (!response.ok) {
    throw new Error(`Fi native command receipt failed (${response.status})`);
  }
  const result: unknown = await response.json();
  params.assertCurrent();
  if (
    !result ||
    typeof result !== "object" ||
    !("ok" in result) ||
    result.ok !== true ||
    !("agentId" in result) ||
    result.agentId !== "cellect-main" ||
    !("credentialClass" in result) ||
    result.credentialClass !== "operator" ||
    !("orgId" in result) ||
    result.orgId !== turn.orgId ||
    !("operationCommand" in result) ||
    !result.operationCommand ||
    typeof result.operationCommand !== "object" ||
    !("orgId" in result.operationCommand) ||
    result.operationCommand.orgId !== turn.orgId ||
    !("receipt" in result.operationCommand) ||
    !("expiresAt" in result.operationCommand)
  ) {
    throw new Error("Native RFI upload receipt is unavailable");
  }
  return {
    token: result.operationCommand.receipt,
    expiresAt: result.operationCommand.expiresAt,
    operationReceipt: true,
  };
}
