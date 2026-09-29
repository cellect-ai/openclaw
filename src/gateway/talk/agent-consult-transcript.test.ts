import { describe, expect, it } from "vitest";
import { prepareTalkAgentConsultTranscript } from "./agent-consult-transcript.js";

describe("Talk agent consult transcript visibility", () => {
  it("hides the consult's completed final because realtime voice owns the spoken answer", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "The requested result." }],
      stopReason: "stop",
    } as never;

    expect(prepareTalkAgentConsultTranscript(message, "The requested result.")).toMatchObject({
      display: false,
    });
  });

  it.each(["toolUse", "error", "aborted"])(
    "keeps %s and interrupted consult output visible for recovery",
    (stopReason) => {
      const message = {
        role: "assistant",
        content: [{ type: "text", text: "Still working or interrupted." }],
        stopReason,
      } as never;

      expect(prepareTalkAgentConsultTranscript(message, undefined)).not.toHaveProperty(
        "display",
        false,
      );
    },
  );
});
