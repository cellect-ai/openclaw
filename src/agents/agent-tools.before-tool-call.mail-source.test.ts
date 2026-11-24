import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMailWakeSourceLock } from "../infra/mail-wake-source-lock.js";
import { resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  wrapToolWithBeforeToolCallHook,
  isPreExecutionBlockedToolResult,
} from "./agent-tools.before-tool-call.js";

describe("mail source requester continuation admission", () => {
  afterEach(() => resetGlobalHookRunner());

  it.each(["sessions_spawn", "sessions_send", "subagents", "cron", "automations"])(
    "blocks %s before any requester continuation or child credential can be minted",
    async (name) => {
      const release = registerMailWakeSourceLock({
        runId: "mail-run",
        sessionKey: "agent:cellect-fi-admin:hook:fi-mail:thread",
        capability: `slw:carrier:${"a".repeat(43)}`,
      });
      const mintChildCredential = vi.fn();
      const createRequesterContinuation = vi.fn(async () => {
        mintChildCredential();
        return { content: [{ type: "text" as const, text: "child started" }] };
      });
      const tool = wrapToolWithBeforeToolCallHook(
        {
          name,
          label: name,
          description: name,
          parameters: { type: "object", properties: {} },
          execute: createRequesterContinuation,
        },
        {
          agentId: "cellect-fi-admin",
          sessionKey: "agent:cellect-fi-admin:hook:fi-mail:thread",
          runId: "mail-run",
        },
      );
      try {
        const result = await tool.execute("child", {
          requesterProfile: { channel: "slack", senderId: "U12345678" },
          sessionKey: "agent:cellect-fi-admin:slack:direct:u12345678",
          sourceLockCapability: "",
          hookMailWakeSessionKey: "",
        });
        expect(isPreExecutionBlockedToolResult(result)).toBe(true);
        expect(createRequesterContinuation).not.toHaveBeenCalled();
        expect(mintChildCredential).not.toHaveBeenCalled();
      } finally {
        release();
      }
    },
  );

  it("also blocks isolated mail runs without receipts, and leaves unrelated manual sessions available", async () => {
    const sessionKey = "agent:cellect-fi-admin:cron:projection:run:isolated";
    const release = registerMailWakeSourceLock({
      runId: "isolated-mail",
      sessionKey,
      capability: undefined,
      mailSessionKey: "agent:cellect-fi-admin:hook:fi-mail:thread",
    });
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "started" }] }));
    const source = {
      name: "sessions_spawn",
      label: "spawn",
      description: "spawn",
      parameters: { type: "object", properties: {} },
      execute,
    };
    try {
      expect(
        isPreExecutionBlockedToolResult(
          await wrapToolWithBeforeToolCallHook(source, {
            sessionKey,
            runId: "isolated-mail",
          }).execute("mail", {}),
        ),
      ).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      const manual = wrapToolWithBeforeToolCallHook(source, {
        sessionKey: "agent:cellect-fi-admin:slack:direct:u12345678",
        runId: "manual",
      });
      expect(isPreExecutionBlockedToolResult(await manual.execute("manual", {}))).toBe(false);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
  });
});
