import { normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SlackActionContext } from "./action-context.js";
import { getOptionalSlackRuntime } from "./runtime.js";

/**
 * Returns the host-verified Slack sender for this action when it came from a
 * live Slack conversation on the same account; undefined for delegated,
 * detached, or cross-account callers.
 */
function resolveTrustedSlackRequesterId(
  accountId: string,
  context?: SlackActionContext,
): string | undefined {
  const requesterAccountId = context?.requesterAccountId?.trim();
  const requesterSenderId = context?.requesterSenderId?.trim();
  if (
    normalizeOptionalLowercaseString(context?.currentChannelProvider) !== "slack" ||
    !requesterAccountId ||
    normalizeAccountId(requesterAccountId) !== normalizeAccountId(accountId) ||
    !requesterSenderId ||
    !/^[UW][A-Z0-9]+$/i.test(requesterSenderId)
  ) {
    return undefined;
  }
  return requesterSenderId.toUpperCase();
}

/** Identity mapping is read-only; the source provider and account stay intact. */
export async function resolveSlackReadRequester(
  accountId: string,
  context: SlackActionContext | undefined,
): Promise<string | undefined> {
  if (normalizeOptionalLowercaseString(context?.currentChannelProvider) === "slack") {
    return resolveTrustedSlackRequesterId(accountId, context);
  }
  if (
    normalizeOptionalLowercaseString(context?.currentChannelProvider) !== "matrix" ||
    !context?.sessionKey ||
    !context.requesterAccountId ||
    !context.requesterSenderId
  ) {
    return undefined;
  }
  // Fi revalidates the admitted Matrix turn and its unique linked Slack actor.
  // Never use model params, MXID localparts, or display names.
  const resolver = getOptionalSlackRuntime()?.channel.runtimeContexts.get<{
    resolveSender: (requester: {
      sessionKey: string;
      accountId: string;
      senderId: string;
    }) => Promise<string | undefined>;
  }>({ channelId: "matrix", capability: "requester-slack-identity" });
  const senderId = await resolver?.resolveSender({
    sessionKey: context.sessionKey,
    accountId: context.requesterAccountId,
    senderId: context.requesterSenderId,
  });
  context.assertDirectAdapterHandoff?.();
  return senderId && /^[UW][A-Z0-9]+$/i.test(senderId) ? senderId.toUpperCase() : undefined;
}
export function readSlackPlatformErrorCode(error: unknown): string | undefined {
  const data = (error as { data?: { error?: unknown } } | undefined)?.data;
  if (typeof data?.error === "string") {
    return data.error;
  }
  const message = error instanceof Error ? error.message : undefined;
  return message?.match(/An API error occurred: ([a-z_]+)/)?.[1];
}
