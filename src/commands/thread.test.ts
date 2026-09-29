import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  replaceSessionEntrySync,
  replaceTranscriptEventsSync,
} from "../config/sessions/session-accessor.js";
import { parseSlackThreadPermalink, readThreadTranscriptTail } from "./thread.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseSlackThreadPermalink", () => {
  it("uses thread_ts for a reply permalink and builds the canonical session suffix", () => {
    expect(
      parseSlackThreadPermalink(
        "https://shape-equity-partners.slack.com/archives/C0BJLAWS49H/p1785766836369329?thread_ts=1785541458.788849&cid=C0BJLAWS49H",
      ),
    ).toMatchObject({
      channelId: "C0BJLAWS49H",
      threadTs: "1785541458.788849",
      sessionSuffix: ":slack:channel:c0bjlaws49h:thread:1785541458.788849",
    });
  });

  it("converts a root permalink timestamp when thread_ts is absent", () => {
    expect(
      parseSlackThreadPermalink(
        "https://shape-equity-partners.slack.com/archives/C0BJLAWS49H/p1786731202876369",
      ).threadTs,
    ).toBe("1786731202.876369");
  });

  it("rejects non-Slack permalink paths", () => {
    expect(() => parseSlackThreadPermalink("https://example.com/not-a-thread")).toThrow(
      "Expected a Slack permalink path",
    );
  });
});

describe("readThreadTranscriptTail", () => {
  it("reads the bounded recent tail from SQLite without materializing a JSONL export", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-thread-command-"));
    tempDirs.push(dir);
    const agentId = "fi-admin";
    const sessionId = "session-thread";
    const sessionKey = "agent:fi-admin:slack:channel:c123:thread:123.456";
    const storePath = path.join(dir, "sessions.json");
    replaceSessionEntrySync(
      { agentId, sessionKey, storePath },
      {
        sessionId,
        updatedAt: 1,
      },
    );
    replaceTranscriptEventsSync({ agentId, sessionId, sessionKey, storePath }, [
      ...Array.from({ length: 201 }, (_, index) => ({
        type: "message",
        timestamp: `2026-09-14T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
        message: {
          role: "toolResult",
          toolName: index === 0 ? "outside-bounded-tail" : `tool-${index}`,
          ...(index === 0 ? { errorMessage: "outside bounded tail" } : {}),
          content: [],
        },
      })),
      {
        type: "message",
        timestamp: "2026-09-14T00:04:00.000Z",
        message: {
          role: "toolResult",
          toolName: "latest-tool",
          content: [],
        },
      },
    ]);

    await expect(
      readThreadTranscriptTail({
        agentId,
        sessionKey,
        storePath,
        entry: { sessionId, updatedAt: 1 },
      }),
    ).resolves.toEqual({
      lastTool: "latest-tool",
      lastToolAt: "2026-09-14T00:04:00.000Z",
    });
    expect(fs.existsSync(storePath)).toBe(false);
    expect(fs.readdirSync(dir).some((name) => name.endsWith(".jsonl"))).toBe(false);
  });
});
