import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { handleToolExecutionStart } from "../../agents/embedded-agent-subscribe.handlers.tools.js";
import { createTestContext } from "../../agents/embedded-agent-subscribe.handlers.tools.test-support.js";
import { withQuestionGateway } from "../../agents/harness/gateway-question.test-support.js";
import { createOpenClawTools } from "../../agents/openclaw-tools.js";
import { createChannelQuestionPromptDelivery } from "../../agents/tools/question-prompt-send.js";
import type { ChannelOutboundPayloadContext } from "../../channels/plugins/outbound.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

it.for(["tool", "subscriber"] as const)(
  "delivers one routed question through the %s owner and resumes with the answer",
  async (owner, { signal }) => {
    await withOpenClawTestState({ prefix: "routed-question-delivery-" }, async (state) => {
      await withQuestionGateway(async (fixture) => {
        const sessionKey = "agent:main:main";
        const runId = "routed-question-run";
        const cfg: OpenClawConfig = {
          agents: { entries: { main: { workspace: state.workspaceDir } } },
          plugins: { enabled: false },
          tools: { web: { search: { enabled: false }, fetch: { enabled: false } } },
        };
        const delivered = createDeferred<ChannelOutboundPayloadContext>();
        const sendPayload = vi.fn<
          (
            context: ChannelOutboundPayloadContext,
          ) => Promise<{ channel: "matrix"; messageId: string }>
        >(async (context) => {
          await context.onPlatformSendDispatch?.();
          delivered.resolve(context);
          return { channel: "matrix", messageId: "question-prompt-message" };
        });
        const registry = captureActivePluginRegistrySnapshot();
        setActivePluginRegistry(
          createTestRegistry([
            {
              pluginId: "matrix",
              source: "test",
              plugin: createOutboundTestPlugin({
                id: "matrix",
                outbound: {
                  deliveryMode: "direct",
                  sendPayload,
                  sendText: (context) =>
                    sendPayload({ ...context, payload: { text: context.text } }),
                },
              }),
            },
          ]),
        );
        const routing = {
          channel: "matrix",
          to: "!question-room:example.test",
          accountId: "question-account",
          threadId: "question-thread",
        };
        const args = {
          questions: [
            {
              id: "destination",
              header: "Destination",
              question: "Where should this continue?",
              options: [{ label: "This conversation" }, { label: "Another conversation" }],
            },
          ],
        };
        let execution: Promise<unknown> | undefined;
        try {
          const tool = createOpenClawTools({
            config: cfg,
            agentSessionKey: sessionKey,
            runId,
            agentChannel: routing.channel,
            currentChannelId: routing.to,
            agentAccountId: routing.accountId,
            currentThreadTs: routing.threadId,
            workspaceDir: state.workspaceDir,
            disablePluginTools: true,
            wrapBeforeToolCallHook: false,
          }).find((candidate) => candidate.name === "ask_user");
          if (!tool) {
            throw new Error("routed question tool was not constructed");
          }
          if (owner === "subscriber") {
            const { ctx } = createTestContext();
            Object.assign(ctx.params, {
              sessionKey,
              runId,
              agentId: "main",
              config: cfg,
              messageChannel: routing.channel,
              onToolResult: createChannelQuestionPromptDelivery({ cfg, ...routing })?.send,
            });
            await handleToolExecutionStart(ctx, {
              type: "tool_execution_start",
              toolName: "ask_user",
              toolCallId: "routed-question",
              args,
            });
          }
          execution = tool.execute("routed-question", args, fixture.backingRun.signal);
          // This is the actual durable delivery's channel adapter, not callback metadata.
          const prompt = await withinTest(
            awaitGateBeforeSettlement(
              delivered.promise,
              execution,
              "routed question completed before its prompt reached the conversation",
            ),
            signal,
          );
          expect(prompt).toMatchObject({
            to: routing.to,
            accountId: routing.accountId,
            threadId: routing.threadId,
          });
          expect(prompt.payload.text).toContain("Where should this continue?");
          const [question] = fixture.manager.list();
          expect(question).toBeDefined();
          expect(prompt.payload.channelData).toMatchObject({
            askUser: { questionId: question!.id },
          });
          fixture.manager.resolve(
            question!.id,
            { answers: { destination: ["This conversation"] } },
            "fixture-user",
          );
          expect(await withinTest(execution, signal)).toMatchObject({
            details: {
              status: "answered",
              answers: { answers: { destination: ["This conversation"] } },
            },
          });
          expect(sendPayload).toHaveBeenCalledOnce();
        } finally {
          fixture.backingRun.abort();
          await execution?.catch(() => undefined);
          restoreActivePluginRegistrySnapshot(registry);
        }
      });
    });
  },
);
