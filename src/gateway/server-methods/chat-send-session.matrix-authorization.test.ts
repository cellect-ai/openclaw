import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ guard: vi.fn(), loadSessionEntry: vi.fn() }));
vi.mock("../matrix-browser-session-authorization.js", () => ({
  isUnauthorizedRawMatrixBrowserSession: mocks.guard,
}));
vi.mock("../session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils.js")>()),
  loadSessionEntry: mocks.loadSessionEntry,
}));
vi.mock("./chat-origin-routing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chat-origin-routing.js")>()),
  resolveRequestedChatAgentId: () => ({ ok: true, agentId: "admin" }),
}));

import { prepareChatSendSession } from "./chat-send-session.js";

describe("chat.send Matrix browser authorization", () => {
  it("rejects a canonical admin session outside the authenticated device ceiling", () => {
    const cfg = { session: {} } as never;
    mocks.loadSessionEntry.mockReturnValue({
      cfg,
      storePath: "/state/admin/sessions.json",
      entry: { sessionId: "existing" },
      canonicalKey: "agent:admin:matrix:channel:!secret:thread:$root",
      legacyKey: undefined,
    });
    mocks.guard.mockReturnValue(false);
    const clientInfo = { id: "spoofed-cli", version: "test", platform: "web", mode: "cli" };
    const result = prepareChatSendSession({
      request: {
        p: { sessionKey: "known-key", idempotencyKey: "attempt" },
        clientInfo,
        normalizedAttachments: [],
        turnKind: "main",
        rawMessage: "do not inject",
      } as never,
      context: { getRuntimeConfig: () => cfg } as never,
      client: {
        connect: { client: clientInfo },
        allowedAgentIds: ["fi-user"],
      } as never,
    });
    expect(result).toEqual({
      ok: false,
      error: "Matrix conversations require an authorized conversation binding",
    });
  });

  it("rejects after canonical session resolution and before chat admission", () => {
    const cfg = { session: {} } as never;
    mocks.loadSessionEntry.mockReturnValue({
      cfg,
      storePath: "/state/admin/sessions.json",
      entry: { sessionId: "existing" },
      canonicalKey: "agent:admin:matrix:channel:!secret:thread:$root",
      legacyKey: undefined,
    });
    mocks.guard.mockReturnValue(true);
    const clientInfo = {
      id: "openclaw-control-ui",
      version: "test",
      platform: "web",
      mode: "webchat",
    };
    const result = prepareChatSendSession({
      request: {
        p: { sessionKey: "known-key", idempotencyKey: "attempt" },
        clientInfo,
        explicitOrigin: undefined,
        normalizedAttachments: [],
        turnKind: "main",
        rawMessage: "do not inject",
      } as never,
      context: { getRuntimeConfig: () => cfg } as never,
      client: { connect: { client: clientInfo } } as never,
    });
    expect(result).toEqual({
      ok: false,
      error: "Matrix conversations require an authorized conversation binding",
    });
    expect(mocks.guard).toHaveBeenCalledWith({
      cfg,
      clientInfo,
      sessionKey: "agent:admin:matrix:channel:!secret:thread:$root",
      authorizedByBinding: false,
    });
  });
});
