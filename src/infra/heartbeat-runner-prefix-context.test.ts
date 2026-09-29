import { describe, expect, it } from "vitest";
import { resolveResponsePrefixTemplate } from "../auto-reply/reply/response-prefix-template.js";
import type { OpenClawConfig } from "../config/config.js";
import { createHeartbeatReplyPrefixContext } from "./heartbeat-runner-execution.js";

describe("heartbeat reply prefix context", () => {
  it("resolves a requester mention to empty for an internal wake", () => {
    const bundle = createHeartbeatReplyPrefixContext({
      cfg: { messages: { responsePrefix: "{sender.mention}" } } as OpenClawConfig,
      agentId: "main",
    });

    expect(
      resolveResponsePrefixTemplate(bundle.responsePrefix, bundle.responsePrefixContextProvider()),
    ).toBe("");
  });
});
