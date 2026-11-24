import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { identifiedClient } from "./sessions-read-cache.test-support.js";
import { sessionReadHandlers } from "./sessions-read.js";
import type { RespondFn } from "./types.js";

async function fixture(sessionKey: string, matrix: boolean) {
  const cfg = { plugins: { enabled: false } };
  setRuntimeConfigSnapshot(cfg);
  const scope = { agentId: "main", sessionKey, sessionId: "browser-read-session" };
  await upsertSessionEntryCore(scope, {
    sessionId: scope.sessionId,
    updatedAt: 1,
    visibility: "shared",
    createdActor: { type: "human", source: "profile", id: "owner" },
    ...(matrix
      ? {
          delivery: {
            kind: "external" as const,
            route: { channel: "matrix", target: { to: "!secret:example.org" } },
            context: { channel: "matrix", to: "!secret:example.org" },
            origin: { provider: "matrix" },
          },
        }
      : {}),
  });
  await appendTranscriptMessage(scope, {
    message: { role: "user", content: "private transcript marker", timestamp: 1 },
  });
  const client = identifiedClient("owner");
  const context = await createHistoryReadContext({ getRuntimeConfig: () => cfg });
  const call = async (
    method: "chat.history" | "sessions.get" | "sessions.describe" | "sessions.preview",
  ) => {
    const handler =
      method === "chat.history" ? chatHistoryHandlers[method] : sessionReadHandlers[method];
    const respond = vi.fn<RespondFn>();
    await expectDefined(
      handler,
      method,
    )({
      params:
        method === "chat.history"
          ? { sessionKey }
          : method === "sessions.preview"
            ? { keys: [sessionKey] }
            : { key: sessionKey },
      context,
      client,
      respond,
      req: { type: "req", id: method, method },
      isWebchatConnect: () => true,
    });
    return respond;
  };
  return { call, client, context };
}

describe("Matrix browser read authorization", () => {
  it.each([
    "agent:main:matrix:channel:!secret:example.org:thread:$root",
    "agent:main:legacy-alias",
  ])("hides raw Matrix transcript %s across native read owners", async (sessionKey) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { call } = await fixture(sessionKey, true);
      expect(await call("chat.history")).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "FORBIDDEN" }),
      );
      expect(await call("sessions.get")).toHaveBeenCalledWith(true, { messages: [] }, undefined);
      expect(await call("sessions.describe")).toHaveBeenCalledWith(true, { session: null });
      expect(await call("sessions.preview")).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ previews: [{ key: sessionKey, status: "missing", items: [] }] }),
        undefined,
      );
    });
  });

  it("preserves native internal browser history and rechecks the device ceiling after I/O", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { call, client, context } = await fixture("agent:main:ordinary-browser", false);
      expect(await call("chat.history")).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          messages: [expect.objectContaining({ content: "private transcript marker" })],
        }),
      );
      client.allowedAgentIds = ["main"];
      context.readChatStartupProjection = vi.fn(async () => {
        client.allowedAgentIds = [];
        return undefined;
      });
      expect(await call("chat.history")).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "FORBIDDEN" }),
      );
    });
  });
});
