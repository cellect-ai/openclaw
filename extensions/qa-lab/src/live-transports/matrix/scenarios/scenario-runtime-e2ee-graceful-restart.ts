import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import type { MatrixShutdownCheckpoint, MatrixSyncCacheRecord } from "@openclaw/matrix/test-api.js";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseByPathAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { loadMatrixQaE2eeRuntime } from "../substrate/e2ee-client.js";
import { requestMatrixJson } from "../substrate/request.js";
import {
  buildMatrixE2eeReplyArtifact,
  runMatrixQaE2eeTopLevelWithClient,
  withMatrixQaIsolatedE2eeDriverRoom,
} from "./scenario-runtime-e2ee-room.js";
import { findMatrixQaCliAccountRoot } from "./scenario-runtime-e2ee-state.js";
import {
  buildMatrixQaToken,
  buildMentionPrompt,
  isMatrixQaExactMarkerReply,
  resolveMatrixQaNoReplyWindowMs,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";
import type { MatrixQaScenarioExecution } from "./scenario-types.js";

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Missing ${label}`);
  return value;
}

export function readMatrixGracefulCheckpointStatus(value: unknown, accountId: string) {
  const accounts = record(value, "channel status").channelAccounts;
  const rows = record(accounts, "channel accounts").matrix;
  if (!Array.isArray(rows)) throw new Error("Missing Matrix channel accounts");
  const matching = rows.filter((row) => isRecord(row) && row.accountId === accountId);
  if (matching.length !== 1) throw new Error("Matrix checkpoint account must be unique");
  const application = record(
    record(matching[0], "Matrix account").application,
    "Matrix application status",
  );
  const checkpoint = record(application.matrixCheckpoint, "Matrix checkpoint support");
  if (
    checkpoint.version !== 1 ||
    checkpoint.accountId !== accountId ||
    typeof checkpoint.storeId !== "string" ||
    !checkpoint.storeId
  ) {
    throw new Error("Matrix checkpoint has the wrong account/store identity");
  }
  return { storeId: checkpoint.storeId, restored: checkpoint.restored };
}

export function assertMatrixGracefulCheckpointRestored(
  saved: MatrixShutdownCheckpoint,
  restored: unknown,
) {
  if (!isDeepStrictEqual(restored, saved))
    throw new Error("Successor did not restore the exact source-owned checkpoint");
}

export async function runMatrixQaE2eeGracefulRestartResumeScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const call = context.gatewayCall;
  const restart = context.restartGatewayAfterOwnedExit;
  const stateDir = context.gatewayStateDir;
  const deviceId = context.sutDeviceId;
  if (!call || !restart || !stateDir || !deviceId)
    throw new Error(
      "Matrix graceful E2EE proof requires owned restart, native RPC, state, and device identity",
    );
  const accountId = context.sutAccountId ?? "sut";
  return withMatrixQaIsolatedE2eeDriverRoom(
    context,
    "matrix-e2ee-graceful-restart-resume",
    async ({ client, driverUserId, roomId, roomKey }) => {
      const first = await runMatrixQaE2eeTopLevelWithClient(context, {
        client,
        driverUserId,
        roomId,
        roomKey,
        tokenPrefix: "MATRIX_QA_GRACEFUL_BEFORE",
      });
      const info = record(await call("system.info", {}), "gateway identity");
      if (
        typeof info.pid !== "number" ||
        !Number.isSafeInteger(info.pid) ||
        info.pid <= 0 ||
        typeof info.processInstanceId !== "string" ||
        !info.processInstanceId
      )
        throw new Error("Invalid predecessor process identity");
      const target = { pid: info.pid, processInstanceId: info.processInstanceId };
      const baseline = readMatrixGracefulCheckpointStatus(
        await call("channels.status", { probe: false }),
        accountId,
      );
      const requestId = `matrix-graceful-${randomUUID()}`;
      const prepared = record(
        await call("gateway.suspend.prepare", {
          requestId,
          target,
          drain: true,
          terminalPolicy: "preserve",
        }),
        "native suspension",
      );
      if (
        (prepared.status !== "ready" && prepared.status !== "draining") ||
        typeof prepared.suspensionId !== "string"
      )
        throw new Error("Native gateway did not prepare suspension");
      const suspensionId = prepared.suspensionId;
      const tokens = [
        buildMatrixQaToken("MATRIX_QA_GRACEFUL_DRAIN"),
        buildMatrixQaToken("MATRIX_QA_GRACEFUL_OFFLINE"),
      ];
      const send = (token: string) =>
        client.sendTextMessage({
          roomId,
          body: buildMentionPrompt(context.sutUserId, token),
          mentionUserIds: [context.sutUserId],
        });
      const assertEncrypted = async (eventId: string) => {
        const response = await requestMatrixJson<unknown>({
          accessToken: context.sutAccessToken,
          baseUrl: context.baseUrl,
          endpoint: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`,
          fetchImpl: fetch,
          method: "GET",
        });
        if (record(response.body, "wire event").type !== "m.room.encrypted")
          throw new Error("Matrix proof event was not encrypted on the wire");
      };
      let committed = false;
      let saved: MatrixShutdownCheckpoint | undefined;
      let offlineEventId = "";
      try {
        const drainEventId = await send(tokens[0]!);
        await assertEncrypted(drainEventId);
        const queue = createChannelIngressQueueForTests<{ version: 1; rawEvent: string }>({
          channelId: "matrix",
          accountId,
          stateDir,
          access: "read-only",
        });
        try {
          const deadline = Date.now() + context.timeoutMs;
          for (;;) {
            const retained = (await queue.listPending({ limit: "all" })).find(
              (row) => row.id === JSON.stringify([roomId, drainEventId]),
            );
            if (retained) {
              const raw = record(JSON.parse(retained.payload.rawEvent), "durable Matrix envelope");
              if (
                raw.roomId !== roomId ||
                record(raw.event, "durable Matrix event").sender !== driverUserId
              )
                throw new Error("Retained Matrix arrival has the wrong provenance");
              break;
            }
            if (Date.now() >= deadline)
              throw new Error("Encrypted suspension arrival was not durably admitted");
            await sleep(50);
          }
        } finally {
          await closeOpenClawStateDatabaseByPathAsync(
            path.join(stateDir, "state", "openclaw.sqlite"),
          );
        }
        const deadline = Date.now() + context.timeoutMs;
        for (;;) {
          const status = record(
            await call("gateway.suspend.status", { suspensionId, includeLifecycle: true }),
            "suspension status",
          );
          if (status.pid !== target.pid || status.processInstanceId !== target.processInstanceId)
            throw new Error("Predecessor changed during drain");
          if (status.status === "ready") break;
          if (status.status !== "draining" || Date.now() >= deadline)
            throw new Error("Native Matrix gateway did not finish draining");
          await sleep(50);
        }
        const exit = await restart(
          async () => {
            const result = record(
              await call("gateway.suspend.handoff", {
                suspensionId,
                target,
                commit: true,
                requireIdle: true,
              }),
              "native handoff",
            );
            if (result.status !== "committed" || result.suspensionId !== suspensionId)
              throw new Error("Native suspension stop was not committed");
            committed = true;
          },
          async () => {
            const root = await findMatrixQaCliAccountRoot({
              accountId,
              deviceId,
              userId: context.sutUserId,
              runtime: { stateDir },
            });
            const runtime = await loadMatrixQaE2eeRuntime();
            const store = createPluginStateKeyedStoreForTests<MatrixSyncCacheRecord>(
              "matrix",
              runtime.openMatrixSyncCacheStoreOptions(root),
            );
            try {
              const persisted = await runtime.readPersistedStoreFromStore({
                storageRootDir: root,
                store,
              });
              const proof = persisted?.checkpoint;
              if (
                !persisted?.cleanShutdown ||
                !persisted.savedSync ||
                !proof ||
                proof.requestId !== requestId ||
                proof.suspensionId !== suspensionId ||
                proof.predecessorProcessInstanceId !== target.processInstanceId ||
                proof.accountId !== accountId ||
                proof.storeId !== baseline.storeId ||
                !proof.generation
              )
                throw new Error("Predecessor did not persist the exact clean operation checkpoint");
              saved = { ...proof };
            } finally {
              await closeOpenClawStateDatabaseByPathAsync(
                path.join(root, "state", "openclaw.sqlite"),
              );
            }
            offlineEventId = await send(tokens[1]!);
            await assertEncrypted(offlineEventId);
          },
        );
        if (exit.pid !== target.pid || exit.exitCode !== 0 || exit.signalCode !== null)
          throw new Error("Gateway replacement did not follow exact-owner natural exit");
        const successorInfo = record(await call("system.info", {}), "successor identity");
        if (successorInfo.processInstanceId === target.processInstanceId)
          throw new Error("Gateway did not create a successor process instance");
        const restored = readMatrixGracefulCheckpointStatus(
          await call("channels.status", { probe: false }),
          accountId,
        );
        if (restored.storeId !== baseline.storeId || !saved)
          throw new Error("Successor checkpoint store identity changed");
        assertMatrixGracefulCheckpointRestored(saved, restored.restored);
        const replies = new Map<string, ReturnType<typeof buildMatrixE2eeReplyArtifact>>();
        for (let index = 0; index < tokens.length; index++) {
          const matched = await client.waitForRoomEvent({
            roomId,
            timeoutMs: context.timeoutMs,
            predicate: (event) =>
              tokens.some((token) =>
                isMatrixQaExactMarkerReply(event, { roomId, sutUserId: context.sutUserId, token }),
              ),
          });
          const token = tokens.find((candidate) =>
            isMatrixQaExactMarkerReply(matched.event, {
              roomId,
              sutUserId: context.sutUserId,
              token: candidate,
            }),
          );
          if (!token || replies.has(token))
            throw new Error("Encrypted backlog reply was duplicated");
          await assertEncrypted(matched.event.eventId);
          replies.set(token, buildMatrixE2eeReplyArtifact(matched.event, token));
        }
        const duplicate = await client.waitForOptionalRoomEvent({
          roomId,
          timeoutMs: resolveMatrixQaNoReplyWindowMs(context.timeoutMs),
          predicate: (event) =>
            tokens.some((token) =>
              isMatrixQaExactMarkerReply(event, { roomId, sutUserId: context.sutUserId, token }),
            ),
        });
        if (duplicate.matched)
          throw new Error("Encrypted backlog produced an additional duplicate reply");
        return {
          artifacts: {
            roomId,
            roomKey,
            firstDriverEventId: first.driverEventId,
            firstReply: first.reply,
            driverEventIds: [drainEventId, offlineEventId],
            replies: [...replies].map(([token, reply]) => ({
              eventId: reply.eventId,
              label: token === tokens[0] ? "drain" : "offline",
              token,
              tokenMatched: reply.tokenMatched,
            })),
            gracefulCheckpoint: {
              ...saved,
              naturalExitPid: exit.pid,
              naturalExitCode: exit.exitCode,
              drainArrivalDurablyRetained: true,
            },
          },
          details:
            "Exact-owner native handoff exited naturally; encrypted suspension/offline arrivals resumed once with the same source-owned checkpoint.",
        };
      } finally {
        if (!committed) await call("gateway.suspend.resume", { suspensionId });
      }
    },
  );
}
