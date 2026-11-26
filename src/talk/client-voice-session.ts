import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  onTrustedInternalDiagnosticEvent,
  onTrustedToolExecutionEvent,
  type TrustedToolExecutionEvent,
} from "../infra/diagnostic-events.js";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-lifecycle-errors.js";
import { captureGatewayRootWorkReleaseObserver } from "../process/gateway-work-admission.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
/** Durable per-agent voice-call records for Talk continuity and mutation evidence. */
import {
  deactivateClientVoiceConfirmationSession,
  releaseClientVoiceConfirmationRun,
} from "./client-voice-confirmation.js";
import {
  CLIENT_VOICE_MUTATION_DIGEST_POLICY,
  ClientVoiceMutationDigestOwner,
  createClientVoiceMutationDigestDeliveryOptions,
} from "./client-voice-mutation-digest-owner.js";
import {
  captureClientVoiceSessionSettlement,
  withClientVoiceSessionResources,
  withClientVoiceSessionSettlement,
} from "./client-voice-session-lifecycle.js";
import { lookupClientVoiceSessions } from "./client-voice-session-read.js";
import {
  captureClientVoiceSessionSource,
  matchesClientVoiceRunSource,
  type ClientVoiceRun,
  type ClientVoiceSessionSource,
  captureClientVoiceSessionWriter,
  type ClientVoiceSessionWriter,
} from "./client-voice-session-source.js";
import {
  assertVoiceSessionOwnership,
  operationKey,
  readVoiceSessionRecord as readRecord,
  VOICE_SESSION_STALE_AFTER_MS as STALE_AFTER_MS,
  type ClientVoiceRunBinding,
  type ClientVoiceSessionRecord,
} from "./client-voice-session-store.js";
import {
  appendVoiceTranscript,
  voiceSessionOperations,
} from "./client-voice-session-transcript.js";
import {
  mutateAuthorizedClientVoiceSession,
  type ClientVoiceSessionMutationAuthority,
} from "./client-voice-session-write.js";
import type { VoiceSessionMutation } from "./client-voice-session-write.kernel.js";

const voiceSessionByRunId = new Map<string, ClientVoiceRun>();

let unsubscribeToolEffects: (() => void) | undefined;
let unsubscribeRunCompletion: (() => void) | undefined;

async function closeVoiceSessionOperationOwner(
  params: Omit<Parameters<typeof closeClientVoiceSessionInternal>[0], "writer">,
  retainedWriter?: ClientVoiceSessionWriter,
): Promise<boolean> {
  return withClientVoiceSessionSettlement(
    async () => {
      const writer = retainedWriter ?? captureClientVoiceSessionWriter(params);
      const resources = retainedWriter ? [] : [writer];
      return withClientVoiceSessionResources(resources, async () => {
        let closed: boolean | undefined;
        await voiceSessionOperations.close(
          operationKey(params.agentId, params.voiceSessionId),
          async () => {
            closed = await closeClientVoiceSessionInternal({ ...params, writer });
          },
        );
        // A joined recovery close may skip a resumed call; explicit closes need their own barrier.
        if (closed === undefined && params.staleBefore === undefined) {
          return await closeVoiceSessionOperationOwner(params, writer);
        }
        return closed ?? false;
      });
    },
    undefined,
    params.physicalSource?.settlementContext ?? retainedWriter?.settlementContext,
  );
}

async function recordClientVoiceToolEffect(event: TrustedToolExecutionEvent): Promise<void> {
  const owner = event.runId ? voiceSessionByRunId.get(event.runId) : undefined;
  if (!owner) {
    return;
  }
  const { binding, source } = owner;
  // Capture the source and enqueue synchronously, before run.completed can retire its binding.
  try {
    await runWithClientVoiceRunSettlement(owner, () =>
      withClientVoiceSessionSettlement(
        async () => {
          const writer = captureClientVoiceSessionWriter({ ...binding, physicalSource: source });
          await withClientVoiceSessionResources([writer], () =>
            writer.mutate({ ...binding, kind: "effect", event, now: Date.now() }),
          );
        },
        undefined,
        source.settlementContext,
      ),
    );
  } catch (error) {
    console.warn(`[talk] voice tool effect persistence failed: ${String(error)}`);
  }
}

function runWithClientVoiceRunSettlement<T>(owner: ClientVoiceRun, run: () => T): T {
  const capture = () => captureClientVoiceSessionSettlement(owner.source.settlementContext);
  // The child admits the asynchronous operation before releasing its synchronous grant.
  const settlement = owner.settlement?.run(capture) ?? capture();
  try {
    return settlement.run(run);
  } finally {
    settlement.release();
  }
}

function retireClientVoiceRun(runId: string, owner: ClientVoiceRun, retry = true): void {
  if (voiceSessionByRunId.get(runId) !== owner) {
    return;
  }
  owner.retired = true;
  voiceSessionByRunId.delete(runId);
  releaseClientVoiceConfirmationRun(owner.binding.agentId, owner.binding.voiceSessionId, runId);
  owner.stopObserving?.();
  try {
    const { binding } = owner;
    if (retry) {
      const retryDigest = () => mutationDigestDeliveryOwner.retry(binding);
      if (owner.settlement) {
        owner.settlement.run(retryDigest);
      } else {
        retryDigest();
      }
    }
  } finally {
    owner.settlement?.release();
  }
}

function ensureToolEffectSubscription(): void {
  unsubscribeToolEffects ??= onTrustedToolExecutionEvent((event) => {
    void recordClientVoiceToolEffect(event);
  });
  unsubscribeRunCompletion ??= onTrustedInternalDiagnosticEvent(
    (event) => {
      if (event.type !== "run.completed") {
        return;
      }
      const owner = voiceSessionByRunId.get(event.runId);
      // Root-backed runs include queued and yielded work beyond diagnostic completion.
      if (!owner || owner.settlement) {
        return;
      }
      retireClientVoiceRun(event.runId, owner);
    },
    { include: ["run.completed"] },
  );
}

export { createOrResumeClientVoiceSession } from "./client-voice-session-write.js";

/** Correlate a consult run with its open call for voice identity and mutation evidence. */
export async function registerClientVoiceConsultRun(
  input: ClientVoiceSessionMutationAuthority & {
    agentId: string;
    sessionKey: string;
    voiceSessionId: string;
    runId: string;
    config?: OpenClawConfig;
    physicalSource?: ClientVoiceSessionSource;
    onRegistered?: (release: () => void) => void;
  },
): Promise<() => void> {
  const params = { ...input };
  const previous = voiceSessionByRunId.get(params.runId);
  const sameBinding =
    previous !== undefined && matchesClientVoiceRunSource(previous, params, params.physicalSource);
  const writer = sameBinding
    ? runWithClientVoiceRunSettlement(previous, () =>
        captureClientVoiceSessionWriter({
          ...params,
          physicalSource: params.physicalSource ?? previous.source,
        }),
      )
    : captureClientVoiceSessionWriter(params);
  const observeRelease = captureGatewayRootWorkReleaseObserver();
  const capture = () => captureClientVoiceSessionSettlement(writer.settlementContext);
  let settlement: ReturnType<typeof capture> | undefined;
  let registered: ClientVoiceRun | undefined;
  return withClientVoiceSessionResources(
    () => (settlement && settlement !== registered?.settlement ? [settlement, writer] : [writer]),
    async () => {
      try {
        settlement = (sameBinding ? previous.settlement?.run(capture) : undefined) ?? capture();
        const accepted = settlement;
        return await accepted.run(() => {
          const mutation: VoiceSessionMutation = {
            kind: "consult",
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            voiceSessionId: params.voiceSessionId,
            runId: params.runId,
            now: Date.now(),
          };
          const publish = (record: ClientVoiceSessionRecord | undefined) => {
            const source = writer.source;
            // A queued replay still commits, but cannot revive its retired run owner.
            const retired = sameBinding && previous.retired;
            let owner = retired ? undefined : voiceSessionByRunId.get(params.runId);
            if (!retired && !matchesClientVoiceRunSource(owner, params, source)) {
              if (owner) {
                retireClientVoiceRun(params.runId, owner);
              }
              owner = {
                binding: Object.freeze({
                  agentId: params.agentId,
                  voiceSessionId: params.voiceSessionId,
                  sessionKey: params.sessionKey,
                }),
                source,
                ...(observeRelease ? { settlement: accepted } : {}),
              };
              registered = owner;
              voiceSessionByRunId.set(params.runId, owner);
              const published = owner;
              owner.stopObserving = observeRelease?.((reason) =>
                retireClientVoiceRun(params.runId, published, reason === "settled"),
              );
            }
            // Replays re-arm a closed call's digest without replacing its accepted owner.
            if (record?.status === "closed" && params.config) {
              mutationDigestDeliveryOwner.record({
                agentId: params.agentId,
                voiceSessionId: params.voiceSessionId,
                context: {
                  config: params.config,
                  source: owner?.source ?? (sameBinding ? previous.source : source),
                },
              });
            }
            ensureToolEffectSubscription();
            const release = () => {
              if (owner) {
                retireClientVoiceRun(params.runId, owner);
              }
            };
            // Publish cleanup with the binding, before resource release can suspend.
            params.onRegistered?.(release);
            return release;
          };
          // Standalone guards stay in the captured writer's admission checks.
          return params.requester || params.source
            ? mutateAuthorizedClientVoiceSession(params, writer, () => mutation, publish)
            : writer.mutate(mutation, publish);
        });
      } catch (error) {
        if (registered) {
          try {
            retireClientVoiceRun(params.runId, registered, false);
          } catch (releaseError) {
            throw createSqliteLifecycleAggregateError(
              [error, releaseError],
              "Voice session registration and cleanup failed",
              error,
            );
          }
        }
        throw error;
      }
    },
  );
}

/** Return the open voice-call binding for one executing run. */
export function resolveClientVoiceRunBinding(runId?: string): ClientVoiceRunBinding | undefined {
  return runId ? voiceSessionByRunId.get(runId)?.binding : undefined;
}

/** Read spoken-confirmation capability through the executing run's retained physical owner. */
export async function isClientVoiceSessionConfirmable(
  binding: ClientVoiceRunBinding,
  runId: string,
): Promise<boolean> {
  const owner = voiceSessionByRunId.get(runId);
  if (!owner || owner.binding !== binding) {
    throw new Error("Voice confirmation run binding is unavailable");
  }
  const assertCurrent = () => {
    if (owner.retired || voiceSessionByRunId.get(runId) !== owner) {
      throw new Error("Voice confirmation run binding changed");
    }
    owner.source.assertCurrent();
  };
  assertCurrent();
  const confirmable = await runWithClientVoiceRunSettlement(owner, () =>
    withClientVoiceSessionSettlement(
      async () => {
        const writer = captureClientVoiceSessionWriter({
          agentId: binding.agentId,
          physicalSource: owner.source,
          assertCurrent,
        });
        return withClientVoiceSessionResources([writer], async () => {
          const read = await writer.read(binding.voiceSessionId);
          assertCurrent();
          if (!read?.record) {
            throw new Error("Voice confirmation session is unavailable");
          }
          assertVoiceSessionOwnership(read.record, binding);
          // An admitted consult can outlive transport close. Capability remains
          // part of that original call; absence of a record never grants a bypass.
          return (
            read.record.origin === "relay" ||
            read.record.transcriptCapable === true ||
            read.record.hasUserTranscript === true
          );
        });
      },
      undefined,
      owner.source.settlementContext,
    ),
  );
  assertCurrent();
  return confirmable;
}

/** Append one finalized client-owned transcript item idempotently. */
export function appendClientVoiceTranscript(
  params: Omit<Parameters<typeof appendVoiceTranscript>[0], "origin">,
  retainedWriter?: ClientVoiceSessionWriter,
): Promise<void> {
  return appendVoiceTranscript({ ...params, origin: "client" }, retainedWriter);
}

/** Wait for the accepted transcript/effect prefix without closing the logical call. */
export async function flushClientVoiceSessionWrites(
  params: {
    agentId: string;
    voiceSessionId: string;
  },
  retainedWriter?: ClientVoiceSessionWriter | null,
): Promise<void> {
  // Failed source admission may join accepted transcripts, never recapture a writer.
  if (retainedWriter === null) {
    await voiceSessionOperations.flush(operationKey(params.agentId, params.voiceSessionId));
    return;
  }
  const writer = retainedWriter ?? captureClientVoiceSessionWriter(params);
  const resources = retainedWriter ? [] : [writer];
  await withClientVoiceSessionResources(resources, async () => {
    await voiceSessionOperations.flush(operationKey(params.agentId, params.voiceSessionId));
    // Join the accepted agent-writer prefix, including synchronous diagnostic producers.
    await runOpenClawAgentWriteAdmission(writer.options, async () => {
      await writer.prepare();
      writer.assertCurrent();
    });
  });
}

/** Append one finalized relay-owned transcript item idempotently. */
export function appendRelayVoiceTranscript(
  params: Omit<Parameters<typeof appendVoiceTranscript>[0], "origin">,
  retainedWriter?: ClientVoiceSessionWriter,
): Promise<void> {
  return appendVoiceTranscript({ ...params, origin: "relay" }, retainedWriter);
}

const digestOptions = createClientVoiceMutationDigestDeliveryOptions(
  () => voiceSessionByRunId,
  captureClientVoiceSessionSettlement,
);
const mutationDigestDeliveryOwner = new ClientVoiceMutationDigestOwner(digestOptions);

async function closeClientVoiceSessionInternal(params: {
  writer: ClientVoiceSessionWriter;
  physicalSource?: ClientVoiceSessionSource;
  expectedOrigin?: "client";
  agentId: string;
  sessionKey: string;
  voiceSessionId: string;
  config: OpenClawConfig;
  transcriptFailurePolicy: "require-success" | "retain-and-close";
  now?: number;
  staleBefore?: number;
}): Promise<boolean> {
  const now = params.now ?? Date.now();
  const closed = await params.writer.mutate({
    kind: "close",
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    voiceSessionId: params.voiceSessionId,
    transcriptFailurePolicy: params.transcriptFailurePolicy,
    expectedOrigin: params.expectedOrigin,
    staleBefore: params.staleBefore,
    now,
  });
  if (!closed) {
    return false;
  }
  deactivateClientVoiceConfirmationSession(params.agentId, params.voiceSessionId);
  // Channel delivery is best-effort and must never delay this durable boundary.
  mutationDigestDeliveryOwner.record({
    agentId: params.agentId,
    voiceSessionId: params.voiceSessionId,
    context: { config: params.config, source: params.writer.source },
  });
  return true;
}

/** Close a logical voice call after its accepted transcript prefix is durable. */
export async function closeClientVoiceSession(
  params: {
    agentId: string;
    sessionKey: string;
    voiceSessionId: string;
    config: OpenClawConfig;
    now?: number;
    expectedOrigin?: "client";
  },
  retainedWriter?: ClientVoiceSessionWriter,
): Promise<void> {
  await closeVoiceSessionOperationOwner(
    {
      ...params,
      transcriptFailurePolicy: "require-success",
    },
    retainedWriter,
  );
}

/**
 * Terminally close a relay call after its bounded append retries settle.
 * Relays have no payload replay owner after teardown, so unresolved hashes remain as audit state.
 */
export async function closeRelayVoiceSessionRecord(
  params: {
    agentId: string;
    sessionKey: string;
    voiceSessionId: string;
    config: OpenClawConfig;
  },
  retainedWriter?: ClientVoiceSessionWriter,
): Promise<void> {
  await closeVoiceSessionOperationOwner(
    {
      ...params,
      transcriptFailurePolicy: "retain-and-close",
    },
    retainedWriter,
  );
}

/** Close abandoned open calls idle for the fixed six-hour recovery window. */
export async function closeStaleClientVoiceSessions(params: {
  agentId: string;
  config: OpenClawConfig;
  excludeVoiceSessionId?: string;
  now?: number;
  warn?: (message: string) => void;
}): Promise<number> {
  const now = params.now ?? Date.now();
  // A new voice session remains a retry point, but channel I/O is detached so a
  // stalled adapter cannot block stale-session recovery.
  const physicalSource = captureClientVoiceSessionSource(params.agentId);
  await physicalSource.prepare();
  mutationDigestDeliveryOwner.retryAgent(params.agentId, {
    config: params.config,
    source: physicalSource,
  });
  const stale = await lookupClientVoiceSessions(
    {
      kind: "stale",
      agentId: params.agentId,
      updatedBefore: now - STALE_AFTER_MS,
      excludeVoiceSessionId: params.excludeVoiceSessionId,
    },
    physicalSource.options,
  );
  let closed = 0;
  for (const record of stale) {
    try {
      const didClose = await closeVoiceSessionOperationOwner({
        agentId: params.agentId,
        physicalSource,
        sessionKey: record.sessionKey,
        voiceSessionId: record.voiceSessionId,
        config: params.config,
        now,
        staleBefore: now - STALE_AFTER_MS,
        transcriptFailurePolicy: "require-success",
      });
      if (didClose) {
        closed += 1;
      }
    } catch (error) {
      params.warn?.(
        `failed to close stale voice session ${record.voiceSessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return closed;
}

const clientVoiceSessionTesting = {
  readRecord,
  digestDeliveryPolicy: CLIENT_VOICE_MUTATION_DIGEST_POLICY,
  reset(): void {
    for (const [runId, owner] of voiceSessionByRunId) {
      retireClientVoiceRun(runId, owner, false);
    }
    voiceSessionOperations.clear();
    mutationDigestDeliveryOwner.clear();
    unsubscribeToolEffects?.();
    unsubscribeToolEffects = undefined;
    unsubscribeRunCompletion?.();
    unsubscribeRunCompletion = undefined;
  },
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.clientVoiceSessionTestApi")] =
    clientVoiceSessionTesting;
}
