import { describe, expect, it } from "vitest";
import { slackProjectionContent } from "./projection-content.js";

describe("Slack projection content", () => {
  it("keeps plain text unchanged", () => {
    expect(slackProjectionContent({ text: "hello" })).toBe("hello");
  });
  it("renders files as linked lines so a file-only message is not empty", () => {
    expect(
      slackProjectionContent({
        text: "",
        files: [
          { name: "budget (1).xlsx", permalink: "https://shape.slack.com/files/U1/F1/budget.xlsx" },
          { title: "image.png" },
          { mode: "tombstone" },
        ],
      }),
    ).toBe("📎 [budget  1 .xlsx](https://shape.slack.com/files/U1/F1/budget.xlsx)\n📎 image.png");
  });
  it("appends files after text and never links a non-https permalink", () => {
    expect(
      slackProjectionContent({
        text: "see attached",
        files: [{ name: "a.pdf", permalink: "javascript:alert(1)" }],
      }),
    ).toBe("see attached\n📎 a.pdf");
  });
  it("uses attachment fallback only when the message has no text", () => {
    const attachments = [{ fallback: "Unfurled preview" }];
    expect(slackProjectionContent({ text: "", attachments })).toBe("Unfurled preview");
    expect(slackProjectionContent({ text: "link", attachments })).toBe("link");
  });
});
