import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import {
  projectSlackChannelThread,
  registerSlackProjectionReconciler,
} from "./channel-projection.js";
import { isSlackDirectSessionKey, recoverSlackDirectProjection } from "./direct-projection.js";
import { projectionFailureKind } from "./projection-failure.js";

export { projectSlackChannelThread };

const MATRIX_ROOM_ID = /![^:\s]+:[^\s]+/;

export type SlackProjectionMessage = {
  content: string;
  sessionKey?: string;
  messageId?: string;
  runId?: string;
  senderId?: string;
};

export type SlackProjectionContext = {
  channelId: string;
  sessionKey?: string;
  messageId?: string;
  runId?: string;
  senderId?: string;
  accountId?: string;
};

export function registerSlackChannelProjection(
  api: OpenClawPluginApi,
  connection: () => { baseUrl: string; token?: string; fullRefreshesPerTick?: number },
) {
  const reconciler = registerSlackProjectionReconciler(api, connection);
  api.registerGatewayMethod(
    "fi.slackProjection.sync",
    async ({ params, respond }) => {
      const { baseUrl, token } = connection();
      try {
        if (token && typeof params?.sessionKey === "string" && params.directSource) {
          respond(
            true,
            await recoverSlackDirectProjection(
              api,
              { baseUrl, token },
              params.sessionKey,
              params.directSource,
            ),
          );
          return;
        }
        if (
          !token ||
          typeof params?.sessionKey !== "string" ||
          typeof params.accountId !== "string" ||
          typeof params.requesterSenderId !== "string"
        ) {
          throw new Error("Missing Slack projection parameters");
        }
        const projected = await projectSlackChannelThread({
          api,
          token,
          baseUrl,
          sessionKey: params.sessionKey,
          accountId: params.accountId,
          requesterSenderId: params.requesterSenderId,
        });
        if (!projected) {
          throw new Error("Unsupported Slack channel session");
        }
        respond(true, { projected: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Slack projection failed";
        respond(false, { error: message }, errorShape(ErrorCodes.UNAVAILABLE, message));
      }
    },
    { scope: "operator.admin" },
  );
  api.on("message_received", (event, context) => {
    if (context.channelId !== "slack") {
      return;
    }
    const sessionKey = event.sessionKey ?? context.sessionKey;
    if (sessionKey && isSlackDirectSessionKey(sessionKey)) {
      reconciler.wake(sessionKey, "direct");
    }
  });
  api.on("message_sent", async (event, context) => {
    if (!event.success || context.channelId !== "slack" || !context.accountId) {
      return;
    }
    const sessionKey = event.sessionKey ?? context.sessionKey;
    reconciler.noteActivity(sessionKey);
    const { baseUrl, token } = connection();
    if (!sessionKey || !token) {
      return;
    }
    if (/^agent:[^:]+:slack:(channel|group):[cg][a-z0-9]+$/i.test(sessionKey)) {
      reconciler.wake(sessionKey);
      return;
    }
    if (isSlackDirectSessionKey(sessionKey)) {
      reconciler.wake(sessionKey, "direct");
      return;
    }
    void projectSlackChannelThread({
      api,
      token,
      baseUrl,
      sessionKey,
      accountId: context.accountId,
      discover: true,
    })
      .then((projected) => {
        if (projected) {
          reconciler.channelProjectionSucceeded(sessionKey);
        }
      })
      .catch((error: unknown) => {
        api.logger.warn(
          `fi-user: channel projection failed after Slack delivery kind=${projectionFailureKind(error)} session=${sessionKey}`,
        );
        reconciler.retryChannelProjection(sessionKey);
      });
  });
  return {
    /** A failed immediate snapshot is live work, not periodic ACL maintenance. */
    retryChannelProjection: reconciler.retryChannelProjection,
    channelProjectionSucceeded: reconciler.channelProjectionSucceeded,
    /** Inbound Slack or Matrix activity: plan its projection rooms ahead of the rotation. */
    noteInboundActivity: (context: {
      channelId: string;
      sessionKey?: string;
      conversationId?: string;
    }) => {
      reconciler.noteActivity(context.sessionKey);
      if (context.channelId === "matrix") {
        reconciler.noteActivity(MATRIX_ROOM_ID.exec(context.conversationId ?? "")?.[0]);
      }
    },
  };
}
