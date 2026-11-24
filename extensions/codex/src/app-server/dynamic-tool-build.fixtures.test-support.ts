import { expectDefined } from "@openclaw/normalization-core";
import { type AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import { type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { shouldEnableCodexAppServerNativeToolSurface } from "./dynamic-tool-build.js";
import { createBridge } from "./dynamic-tools.test-support.js";
import { prepareTestNativeExecutionPolicy } from "./native-execution-policy.test-support.js";
import { type JsonObject } from "./protocol.js";

export async function nativeSurface(
  attempt: EmbeddedRunAttemptParams,
  sandbox?: Parameters<typeof shouldEnableCodexAppServerNativeToolSurface>[1],
  options: Omit<
    Parameters<typeof shouldEnableCodexAppServerNativeToolSurface>[2],
    "nativeExecutionPolicy"
  > = {},
) {
  return shouldEnableCodexAppServerNativeToolSurface(attempt, sandbox, {
    ...options,
    nativeExecutionPolicy: await prepareTestNativeExecutionPolicy(attempt, { sandbox, ...options }),
  });
}

export function toolNamed(tools: AnyAgentTool[], name: string) {
  const found = tools.find((tool) => tool.name === name);
  return expectDefined(found, `Codex ${name} tool`);
}

export function call(
  bridge: ReturnType<typeof createBridge>,
  tool: string,
  args: JsonObject,
  callId = tool,
) {
  return bridge.handleToolCall({
    threadId: "thread-1",
    turnId: "turn-1",
    callId,
    tool,
    arguments: args,
  });
}

export function shellTestToolNames(tools: readonly { name: string }[]): string[] {
  return tools
    .map((tool) => tool.name)
    .filter((name) => ["message", "gateway_exec", "gateway_process", "node_exec"].includes(name));
}

export function namespaceSpec(name: string, tools: unknown) {
  return { type: "namespace", name, description: "", tools };
}

export function textContent<T extends "text" | "inputText">(text: string, type: T) {
  return [{ type, text }];
}
