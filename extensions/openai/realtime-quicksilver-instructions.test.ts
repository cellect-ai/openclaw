import { describe, expect, it } from "vitest";
import { buildOpenAIQuicksilverInstructions } from "./realtime-quicksilver-instructions.js";

describe("OpenAI GPT-Live delegation instructions", () => {
  it("preserves agent identity and delivers one result or failure per check", () => {
    const instructions = buildOpenAIQuicksilverInstructions("gpt-live", "Speak warmly.");

    expect(instructions).toContain("configured OpenClaw agent speaking through realtime voice");
    expect(instructions).toContain("do not identify as ChatGPT or a different service");
    expect(instructions).toContain("deliver exactly one final delegated result or a clear failure");
    expect(instructions).toContain("Speak warmly.");
  });

  it("keeps confirmation ids silent while allowing the same request to be retried", () => {
    const instructions = buildOpenAIQuicksilverInstructions("gpt-live");

    expect(instructions).toContain("VOICE_CONFIRMATION_REQUIRED:<id>");
    expect(instructions).toContain("do not read the id aloud");
    expect(instructions).toContain("delegate the same request again without changing it");
  });
});
