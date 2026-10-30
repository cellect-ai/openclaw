import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import { LET_ME_KNOW_CONTEXT, registerLetMeKnow } from "./let-me-know.js";

type Hook = (event: unknown, context: unknown) => unknown;

function hooks(config: Record<string, unknown> = {}) {
  const registered = new Map<string, Hook>();
  registerLetMeKnow(
    createTestPluginApi({
      id: "fi-user",
      name: "Fi User Delegation",
      config: { plugins: { entries: { "fi-user": { config } } } },
      runtime: {} as OpenClawPluginApi["runtime"],
      on: vi.fn((name: string, handler: Hook) => registered.set(name, handler)) as never,
    }),
  );
  const run = (name: string, context: unknown) => registered.get(name)?.({ prompt: "" }, context);
  return {
    model: (context: unknown) => run("before_model_resolve", context),
    prompt: (context: unknown) => run("before_prompt_build", context),
  };
}

const turn = (chat: Record<string, unknown> = { letMeKnow: true }, sender = {}) => ({
  channel: "matrix",
  channelContext: {
    sender: { id: "@person:matrix.example", ...sender },
    chat: { id: "!room:matrix.example", eventId: "$ask", ...chat },
  },
});

describe("fi-user let-me-know turns", () => {
  it("runs a flagged turn on the configured model and asks for a spoken opening", () => {
    const hook = hooks({ letMeKnowModel: "anthropic/claude-opus-4-1" });

    expect(hook.model(turn())).toEqual({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-1",
    });
    expect(hook.prompt(turn())).toEqual({ appendContext: LET_ME_KNOW_CONTEXT });
  });

  it("keeps a model path after the provider", () => {
    expect(hooks({ letMeKnowModel: "openrouter/anthropic/claude" }).model(turn())).toEqual({
      providerOverride: "openrouter",
      modelOverride: "anthropic/claude",
    });
  });

  it.each([undefined, "", "claude-opus", "/claude", "anthropic/", "anthropic/claude opus"])(
    "keeps the agent's model when letMeKnowModel is %j",
    (letMeKnowModel) => {
      const hook = hooks(letMeKnowModel === undefined ? {} : { letMeKnowModel });

      expect(hook.model(turn())).toBeUndefined();
      expect(hook.prompt(turn())).toEqual({ appendContext: LET_ME_KNOW_CONTEXT });
    },
  );

  it.each([
    ["an unflagged turn", turn({})],
    ["a bot sender", turn({ letMeKnow: true }, { isBot: true })],
    ["a non-boolean flag", turn({ letMeKnow: "true" })],
    ["another channel", { ...turn(), channel: "slack" }],
    ["a turn without channel context", { channel: "matrix" }],
  ])("leaves %s alone", (_label, context) => {
    const hook = hooks({ letMeKnowModel: "anthropic/claude-opus-4-1" });

    expect(hook.model(context)).toBeUndefined();
    expect(hook.prompt(context)).toBeUndefined();
  });
});
