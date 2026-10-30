import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { configFromRuntime } from "./fi-delegation.js";

export const LET_ME_KNOW_CONTEXT =
  "The user asked you to research this and let them know. Be thorough: use your tools to verify. Begin your final reply with a 2-3 sentence plain-language answer that works read aloud (no tables, links or ids in those sentences), then give the full detail and sources.";

/** The Matrix monitor sets the flag only for a person's own flagged message. */
function isLetMeKnowTurn(context: {
  channel?: string;
  channelContext?: { chat?: { letMeKnow?: unknown }; sender?: { isBot?: unknown } };
}): boolean {
  return (
    context.channel === "matrix" &&
    context.channelContext?.chat?.letMeKnow === true &&
    context.channelContext.sender?.isBot !== true
  );
}

/**
 * A "Let me know" turn runs on the configured research model and is told how to
 * open its reply. Both are hook results for this run only; nothing is stored on
 * the session, so the next turn is back on the agent's own model.
 */
export function registerLetMeKnow(api: OpenClawPluginApi): void {
  api.on("before_model_resolve", (_event, context) => {
    const model = isLetMeKnowTurn(context) ? configFromRuntime(api).letMeKnowModel : undefined;
    return model ? { providerOverride: model.provider, modelOverride: model.model } : undefined;
  });
  api.on("before_prompt_build", (_event, context) =>
    isLetMeKnowTurn(context) ? { appendContext: LET_ME_KNOW_CONTEXT } : undefined,
  );
}
