// Slack tests cover permalink parsing.
import { describe, expect, it } from "vitest";
import { parseSlackPermalink } from "./permalink.js";

describe("parseSlackPermalink", () => {
  it("parses a DM message permalink", () => {
    expect(
      parseSlackPermalink("https://cellect.slack.com/archives/D0AB12CD3/p1789143892594259"),
    ).toEqual({ kind: "message", channelId: "D0AB12CD3", messageTs: "1789143892.594259" });
  });

  it("keeps the parent thread of a reply permalink", () => {
    expect(
      parseSlackPermalink(
        "<https://cellect.slack.com/archives/C0AB12CD3/p1789143892594259?thread_ts=1789143800.000100&cid=C0AB12CD3|link>",
      ),
    ).toEqual({
      kind: "message",
      channelId: "C0AB12CD3",
      messageTs: "1789143892.594259",
      threadTs: "1789143800.000100",
    });
  });

  it("parses conversation-only and Enterprise Grid links", () => {
    expect(parseSlackPermalink("https://acme.enterprise.slack.com/archives/G0AB12CD3")).toEqual({
      kind: "message",
      channelId: "G0AB12CD3",
    });
  });

  it("parses file permalinks and private download URLs", () => {
    expect(
      parseSlackPermalink("https://cellect.slack.com/files/U0AD36FDHFC/F0BU7FTCM60/phase_i.pdf"),
    ).toEqual({ kind: "file", fileId: "F0BU7FTCM60" });
    expect(
      parseSlackPermalink(
        "https://files.slack.com/files-pri/T09JRQ3FS91-F0BU7FTCM60/download/phase_i.pdf",
      ),
    ).toEqual({ kind: "file", fileId: "F0BU7FTCM60" });
  });

  it("rejects non-Slack hosts and malformed links", () => {
    expect(parseSlackPermalink("https://slack.com.evil.test/archives/C0AB12CD3")).toBeUndefined();
    expect(parseSlackPermalink("http://cellect.slack.com/archives/C0AB12CD3")).toBeUndefined();
    expect(
      parseSlackPermalink("https://cellect.slack.com/archives/C0AB12CD3/pbad"),
    ).toBeUndefined();
    expect(parseSlackPermalink("C0AB12CD3")).toBeUndefined();
    expect(parseSlackPermalink(undefined)).toBeUndefined();
  });
});
