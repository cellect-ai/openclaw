import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSessionKeys, upsertSessionEntry } from "./session-store-runtime.js";

describe("session-store key inventory", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-session-keys-"));
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("lists durable keys without requiring entry projection", async () => {
    const sessionKey = "agent:main:slack:channel:c123";
    await upsertSessionEntry({
      sessionKey,
      storePath,
      entry: { sessionId: "session-1", updatedAt: 10 },
    });
    await expect(listSessionKeys({ storePath })).resolves.toEqual([sessionKey]);
  });
});
