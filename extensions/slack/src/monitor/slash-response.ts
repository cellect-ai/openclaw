import type { AllMiddlewareArgs } from "@slack/bolt";
import type { SlackCommandMiddlewareArgs } from "@slack/bolt";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { warn } from "openclaw/plugin-sdk/runtime-env";
import { requireSlackPostMessageTimestamp } from "../client-delivery.js";
import type { SlackMonitorContext } from "./context.js";

export function createSlackSlashResponderWithFallback(params: {
  respond: SlackCommandMiddlewareArgs["respond"];
  client: AllMiddlewareArgs["client"];
  command: SlackCommandMiddlewareArgs["command"];
  runtime: SlackMonitorContext["runtime"];
}): SlackCommandMiddlewareArgs["respond"] {
  return async (message) => {
    try {
      return await params.respond(message);
    } catch (error) {
      if (!isSlackBoltRespondError(error)) {
        throw error;
      }
      params.runtime.log?.(
        warn(
          `slack slash response_url failed; falling back to Web API: ${formatErrorMessage(error)}`,
        ),
      );
      return await deliverSlackSlashResponseWithWebApi({
        client: params.client,
        command: params.command,
        message,
      });
    }
  };
}

export async function deliverSlackSlashResponseWithWebApi(params: {
  client: AllMiddlewareArgs["client"];
  token?: string;
  command: Pick<SlackCommandMiddlewareArgs["command"], "channel_id" | "user_id">;
  threadTs?: string;
  message: Parameters<SlackCommandMiddlewareArgs["respond"]>[0];
}): Promise<Response> {
  const payload = typeof params.message === "string" ? { text: params.message } : params.message;
  const text = payload.text ?? "";
  const blocks = "blocks" in payload && Array.isArray(payload.blocks) ? payload.blocks : undefined;
  const mrkdwn =
    "mrkdwn" in payload && typeof payload.mrkdwn === "boolean" ? payload.mrkdwn : undefined;

  const message = {
    ...(params.token !== undefined ? { token: params.token } : {}),
    channel: params.command.channel_id,
    ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
    text,
    ...(blocks ? { blocks } : {}),
    ...(mrkdwn !== undefined ? { mrkdwn } : {}),
  };
  if (payload.response_type === "in_channel") {
    const postSlackMessage = params.client.chat.postMessage.bind(params.client.chat);
    const response = await postSlackMessage(message);
    requireSlackPostMessageTimestamp(response);
  } else {
    await params.client.chat.postEphemeral({ ...message, user: params.command.user_id });
  }
  return new Response(null, { status: 200 });
}

export function isSlackBoltRespondError(error: unknown): boolean {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "slack_bolt_respond_error"
  );
}
