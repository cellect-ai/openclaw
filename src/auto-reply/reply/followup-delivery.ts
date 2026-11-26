import type { resolveFollowupDeliveryDecision } from "./followup-delivery-decision.js";
import { resolveFollowupPayloadContext } from "./followup-delivery-decision.js";
export { resolveFollowupDeliveryDecision } from "./followup-delivery-decision.js";
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { createMissingReplyNotice } from "../../agents/reply-completion.js";
import { buildAgentRuntimeDeliveryPlan } from "../../agents/runtime-plan/build.js";
import { logVerbose } from "../../globals.js";
import { defaultRuntime } from "../../runtime.js";
import { chatRef, type ChatRef } from "../../sessions/chat-ref.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.read.js";
import { getReplyPayloadMetadata, isReplyPayloadTerminalContent } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { deliverBlockReply } from "./block-reply-delivery.js";
import { suppressPendingFinalDelivery } from "./dispatch-from-config.pending-final.js";
import { resolveFollowupDeliveryPayloads } from "./followup-delivery-payloads.js";
import { createFollowupSpeechPreparer } from "./followup-delivery-tts.js";
import {
  appendNativeFinalDelivery,
  resolveNativeFinalDeliveryPlan,
} from "./native-final-delivery.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import { warnPrivateMessageToolFinal } from "./private-message-tool-final.js";
import { enqueueFollowupRun, resolveQueueSettings, type FollowupRun } from "./queue.js";
import type { AdmittedFollowupTurn, FollowupRunnerParams } from "./reply-agent-turn-preparation.js";
import type { ReplyDispatchKind } from "./reply-dispatcher.types.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";
import { isReplyOperationStalledBeforeOutput } from "./stalled-turn-recovery.js";
import { createTypingSignaler } from "./typing-mode.js";

export async function deliverFollowupDecision(params: {
  decision: Awaited<ReturnType<typeof resolveFollowupDeliveryDecision>>;
  turn: AdmittedFollowupTurn;
  defaults: FollowupRunnerParams;
  runId: string;
  runFollowup: (run: FollowupRun) => Promise<void>;
  kind?: ReplyDispatchKind;
  onObservedReplyDelivery?: () => Promise<void> | void;
}) {
  const { decision, turn, defaults } = params;
  if (decision.kind === "suppress") {
    turn.queued.run.internalEventExecution?.onSuppressed?.(decision.reason);
    logVerbose(`followup queue: delivery suppressed (${decision.reason})`);
    return { kind: "completed" as const, payloads: [] };
  }
  if (turn.queued.run.sessionEventOrigin?.deliver === false) {
    if (decision.kind === "deliver")
      await Promise.all(decision.payloads.map((payload) => suppressPendingFinalDelivery(payload)));
    logVerbose("followup queue: delivery suppressed by its silent source event");
    return { kind: "completed" as const, payloads: [] };
  }
  let payloads: ReplyPayload[];
  if (decision.kind === "retry-source-delivery") {
    warnPrivateMessageToolFinal({
      sessionKey: turn.session.kind === "session" ? turn.session.key : undefined,
      channel:
        turn.queued.originatingChannel ??
        turn.queued.run.messageProvider ??
        sessionDeliveryChannel(turn.session.current()),
      finalTextLength: decision.finalTextLength,
    });
    const key = turn.session.kind === "session" ? turn.session.key : turn.queued.run.sessionKey;
    const retrySourceDisposition = turn.queued.queuedFollowupReplyDisposition;
    const retryDelivery =
      retrySourceDisposition?.kind === "deliver"
        ? retrySourceDisposition.deliver.createSourceRetry?.()
        : undefined;
    // A sanctioned stranded-final retry is a new input, not replay of the
    // consumed source or its already-released controller claim.
    const retryRun = {
      ...decision.run,
      controllerInput: undefined,
      controllerClaim: undefined,
      ...(retryDelivery
        ? { queuedFollowupReplyDisposition: { kind: "deliver" as const, deliver: retryDelivery } }
        : {}),
    };
    const enqueued =
      key &&
      enqueueFollowupRun(
        key,
        retryRun,
        resolveQueueSettings({
          cfg: turn.config,
          channel: turn.queued.originatingChannel ?? turn.queued.run.messageProvider,
          sessionEntry: turn.session.current(),
        }),
        "none",
        params.runFollowup,
        false,
        {
          position: "front",
          storePath: turn.session.kind === "session" ? turn.session.storePath : undefined,
        },
      );
    if (enqueued) {
      return { kind: "source-retry" as const };
    }
    payloads = resolveFollowupDeliveryPayloads({
      ...resolveFollowupPayloadContext(turn),
      payloads: [createMissingReplyNotice()],
    });
  } else {
    payloads = decision.payloads;
  }
  const runId = params.runId;
  const kind = params.kind ?? "final";
  const mirror =
    decision.kind === "deliver" && params.kind && params.kind !== "final" ? false : undefined;
  const resolved = decision.resolved;
  const onObservedReplyDelivery = params.onObservedReplyDelivery;
  const { originatingChannel, originatingTo } = turn.queued;
  const originRoutable = Boolean(isRoutableChannel(originatingChannel) && originatingTo);
  const deliveryPlan = buildAgentRuntimeDeliveryPlan({
    provider: resolved?.provider ?? turn.queued.run.provider,
    modelId: resolved?.model ?? turn.queued.run.model,
    config: turn.config,
    workspaceDir: turn.queued.run.workspaceDir,
    agentDir: turn.queued.run.agentDir,
  });
  for (const payload of payloads) {
    if (!hasOutboundReplyContent(payload)) await suppressPendingFinalDelivery(payload);
    else if (kind === "final")
      await appendNativeFinalDelivery(resolveNativeFinalDeliveryPlan(turn.operation), payload, () =>
        turn.operation.abortSignal.throwIfAborted(),
      );
  }
  payloads = payloads.filter((payload) => hasOutboundReplyContent(payload));
  if (payloads.length === 0) {
    return { kind: "completed" as const, payloads: [] };
  }
  const sourceDisposition = turn.queued.queuedFollowupReplyDisposition;
  if (sourceDisposition?.kind === "drop") {
    await Promise.all(payloads.map((payload) => suppressPendingFinalDelivery(payload)));
    logVerbose(`followup queue: source delivery dropped (${sourceDisposition.reason})`);
    return { kind: "completed" as const, payloads: [] };
  }
  const deliverQueuedBatch = sourceDisposition?.deliver;
  if (
    turn.queued.run.internalEventExecution ||
    deliverQueuedBatch?.ownsCompletion?.(originatingChannel)
  ) {
    if (!deliverQueuedBatch) {
      throw new Error("Internal event lost its originating delivery owner");
    }
    if (kind !== "final") {
      await deliverQueuedBatch({
        kind: "queued-followup",
        runId,
        originatingChannel,
        payloads,
        completion: { kind: "progress" },
      });
    }
    return { kind: "completed" as const, payloads };
  }
  const fallbackDispatcher = sourceDisposition ? undefined : defaults.opts?.onBlockReply;
  const dispatcherAvailable = Boolean(deliverQueuedBatch || fallbackDispatcher);
  if (!originRoutable && !dispatcherAvailable) {
    defaultRuntime.error?.(
      "followup queue: completed with payloads but no origin route or visible dispatcher is available",
    );
    return { kind: "completed" as const, payloads: [] };
  }
  const typing = createTypingSignaler({
    typing: defaults.typing,
    mode: defaults.typingMode,
  });
  const crossChannelFailures: ReplyPayload[] = [];
  const queuedPayloads: ReplyPayload[] = [];
  let pending = false;
  const dispatchPayload = async (payload: ReplyPayload) => {
    if (deliverQueuedBatch) {
      queuedPayloads.push(payload);
    } else if (fallbackDispatcher) {
      const delivery = await deliverBlockReply(() => fallbackDispatcher(payload));
      pending ||= delivery.pending === true || delivery.outcome === "recovery-owned";
      if (
        delivery.outcome === "delivered" &&
        !delivery.pending &&
        (!originRoutable || sameChannelOrigin)
      ) {
        await onObservedReplyDelivery?.();
      }
    }
  };
  let deliveredCrossChannelOrigin = false;
  const provider = resolveOriginMessageProvider({
    provider: turn.queued.run.messageProvider,
  });
  const origin = resolveOriginMessageProvider({ originatingChannel });
  const sameChannelOrigin = Boolean(origin && origin === provider);
  const crossChannelOrigin = Boolean(origin && provider && origin !== provider);
  const prepareSpeech = createFollowupSpeechPreparer({ turn, defaults, kind });
  // Queued sends follow the chat by key; a deleted chat drops them.
  const sessionGeneration: ChatRef | undefined =
    turn.session.kind === "session" && turn.session.storePath && turn.session.current()
      ? chatRef({
          agentId: resolveSessionAgentId({
            sessionKey: turn.session.key,
            config: turn.config,
            fallbackAgentId: turn.queued.run.agentId,
          }),
          storePath: turn.session.storePath,
          sessionKey: turn.session.key,
        })
      : undefined;
  for (let payload of payloads) {
    const providerRoute = deliveryPlan.resolveFollowupRoute({
      payload,
      originatingChannel,
      originatingTo,
      originRoutable,
      dispatcherAvailable,
    });
    if (providerRoute?.route === "drop") {
      await suppressPendingFinalDelivery(payload);
      continue;
    }
    const route =
      providerRoute?.route === "origin" && originRoutable
        ? "origin"
        : providerRoute?.route === "dispatcher" && dispatcherAvailable
          ? "dispatcher"
          : originRoutable
            ? "origin"
            : "dispatcher";
    if (route === "origin") {
      // Retain every collected source's policy: an explicit request must not be
      // silenced by a passive message sharing the same follow-up batch.
      const suppressions = (turn.queued.deliveryCorrelations ?? []).flatMap((correlation) =>
        correlation.shouldSuppressReply ? [correlation.shouldSuppressReply(payload)] : [],
      );
      if (suppressions.length > 0 && suppressions.every(Boolean)) {
        await suppressPendingFinalDelivery(payload);
        logVerbose("followup queue: origin reply suppressed by source policy");
        continue;
      }
    }
    await typing.signalTextDelta(payload.text);
    // The stalled recovery owner delivers its terminal notice after the operation aborts.
    if (
      turn.queued.stalledTurnRecovery !== true ||
      !isReplyOperationStalledBeforeOutput(turn.operation)
    ) {
      payload = await prepareSpeech(payload, route);
    }
    if (route !== "origin") {
      await dispatchPayload(payload);
    } else if (isRoutableChannel(originatingChannel) && originatingTo) {
      const metadata = getReplyPayloadMetadata(payload);
      const result = await routeReply({
        payload,
        channel: originatingChannel,
        to: originatingTo,
        agentId: turn.queued.run.agentId,
        sessionKey: turn.queued.run.sessionKey,
        sessionGeneration,
        accountId: turn.queued.originatingAccountId,
        requesterSenderId: turn.queued.run.senderId,
        requesterSenderName: turn.queued.run.senderName,
        requesterSenderUsername: turn.queued.run.senderUsername,
        requesterSenderE164: turn.queued.run.senderE164,
        threadId: turn.queued.originatingThreadId,
        currentMessageId:
          sameChannelOrigin &&
          (turn.queued.run.inputProvenance?.kind === undefined ||
            turn.queued.run.inputProvenance.kind === "external_user")
            ? turn.queued.messageId
            : undefined,
        cfg: turn.config,
        mirror:
          metadata?.assistantMessageIndex !== undefined ||
          metadata?.assistantTranscriptOwned === true
            ? false
            : mirror,
        replyKind: kind,
        runId,
      });
      if (!result.delivered && (result.queueCustody === "held" || result.ambiguous)) {
        pending = true;
        logVerbose(
          `followup queue: route-reply remains pending: ${result.error ?? "unconfirmed delivery"}`,
        );
        continue;
      }
      if (!result.delivered && !result.suppressed) {
        const routeError = result.error ?? "no visible delivery";
        (dispatcherAvailable ? logVerbose : defaultRuntime.error)?.(
          `followup queue: route-reply failed: ${routeError}`,
        );
        if (sameChannelOrigin && dispatcherAvailable) {
          await dispatchPayload(payload);
        } else if (dispatcherAvailable) {
          crossChannelFailures.push(payload);
        }
      } else if (result.delivered) {
        for (const correlation of turn.queued.deliveryCorrelations ?? []) {
          correlation.onReplyDelivered?.(payload);
        }
        await onObservedReplyDelivery?.();
        if (!result.ok) {
          logVerbose(
            `followup queue: route-reply partially failed after delivery: ${
              result.error ?? "unknown error"
            }`,
          );
        }
        deliveredCrossChannelOrigin ||= crossChannelOrigin;
      }
    }
  }
  // A delivered supplement cannot settle missing terminal content, while a
  // delivered terminal reply does settle failures of later supplements.
  const terminalFailure = crossChannelFailures.some(isReplyPayloadTerminalContent);
  if (
    (terminalFailure || (crossChannelFailures.length > 0 && !deliveredCrossChannelOrigin)) &&
    dispatcherAvailable
  ) {
    await dispatchPayload({
      text:
        "Follow-up completed, but OpenClaw could not deliver it to the originating channel. " +
        "The reply content was not forwarded to this channel to avoid cross-channel misdelivery.",
      isError: true,
    });
  }
  if (kind !== "final" && queuedPayloads.length > 0) {
    await deliverQueuedBatch?.({
      kind: "queued-followup",
      runId,
      originatingChannel,
      payloads: queuedPayloads,
      completion: { kind: "progress" },
    });
  }
  return {
    kind: pending ? ("pending" as const) : ("completed" as const),
    payloads: queuedPayloads,
  };
}
