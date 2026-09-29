// Runs plugin hooks before outbound reply payloads are sent.
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type {
  PluginHookReplyPayloadSendingContext,
  PluginHookReplyUsageState,
} from "../../plugins/hook-types.js";
import { copyReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../reply-payload.js";
import { bindReplyPublication } from "../reply-publication.js";
import type { ReplyDispatchKind } from "./reply-dispatcher.types.js";

/** Runs plugin hooks that may rewrite or cancel an outbound reply payload. */
export async function runReplyPayloadSendingHook(
  params: {
    payload: ReplyPayload;
    kind: ReplyDispatchKind;
    channel?: string;
    sessionKey?: string;
    runId?: string;
    usageState?: PluginHookReplyUsageState;
    context: PluginHookReplyPayloadSendingContext;
  },
  hookRunner = getGlobalHookRunner(),
): Promise<ReplyPayload | null> {
  if (!hookRunner?.hasHooks("reply_payload_sending")) {
    return params.payload;
  }

  const event = {
    payload: params.payload,
    kind: params.kind,
    channel: params.channel,
    sessionKey: params.sessionKey,
    runId: params.runId,
    usageState: params.usageState,
  };
  const publication = bindReplyPublication(event, params);
  const publishedEvent = Object.assign(event, {
    publicationId: publication.publicationId,
    publishedAtMs: publication.publishedAtMs,
  });
  const result = await hookRunner.runReplyPayloadSending(publishedEvent, params.context);

  if (result?.cancel) {
    return null;
  }
  const payload = (result?.payload as ReplyPayload | undefined) ?? params.payload;
  return copyReplyPayloadMetadata(params.payload, payload);
}
