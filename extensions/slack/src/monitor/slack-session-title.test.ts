import { beforeEach, describe, expect, it, vi } from "vitest";

const generateConversationLabel = vi.hoisted(() => vi.fn());
const getSessionEntry = vi.hoisted(() => vi.fn());
const patchSessionEntry = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/reply-dispatch-runtime", () => ({
  generateConversationLabel,
}));
vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  getSessionEntry,
  patchSessionEntry,
}));

const {
  buildSlackSessionTitleSource,
  maybeGenerateSlackSessionTitle,
  normalizeSlackSessionTitle,
  scheduleSlackSessionTitleAfterMeta,
} = await import("./slack-session-title.js");

const baseParams = {
  cfg: {},
  agentId: "cellect-fi-admin",
  sessionKey: "agent:cellect-fi-admin:slack:channel:C1:thread:123.456",
  storePath: "/tmp/sessions.json",
  ctx: {
    IsFirstThreadTurn: true,
    GroupSubject: "#fi-admin",
    ThreadStarterBody: "Email from Nicholas — Re: RFI 9_305 3rd St Project",
    CommandBody: "Please file the response and update the RFI log.",
  },
};

describe("Slack session titles", () => {
  beforeEach(() => {
    generateConversationLabel.mockReset();
    getSessionEntry.mockReset();
    patchSessionEntry.mockReset();
  });

  it("builds bounded context from the channel, starter, and triggering request", () => {
    expect(buildSlackSessionTitleSource(baseParams.ctx)).toBe(
      "Conversation: #fi-admin\n" +
        "Thread starter: Email from Nicholas — Re: RFI 9_305 3rd St Project\n" +
        "Current request: Please file the response and update the RFI log.",
    );
    expect(
      buildSlackSessionTitleSource({ ...baseParams.ctx, IsFirstThreadTurn: false }),
    ).toBeNull();
    expect(
      buildSlackSessionTitleSource({
        IsFirstThreadTurn: true,
        CommandBody: "",
        RawBody: "Forwarded email body",
      }),
    ).toBe("Current request: Forwarded email body");
  });

  it("normalizes model wrappers and limits the visible title", () => {
    expect(normalizeSlackSessionTitle('Title: "Nicholas RFI Filing"')).toBe("Nicholas RFI Filing");
    expect(normalizeSlackSessionTitle("```\n\nRFI Response Filing\nextra")).toBe(
      "RFI Response Filing",
    );
  });

  it("persists a generated title without replacing a concurrent manual rename", async () => {
    const initial = {
      sessionId: "session-1",
      updatedAt: 1,
      displayName: "#fi-admin",
    };
    getSessionEntry.mockReturnValue(initial);
    generateConversationLabel.mockResolvedValue("Nicholas RFI Filing");
    patchSessionEntry.mockImplementation(async ({ update }) => {
      const patch = await update(initial);
      return patch ? { ...initial, ...patch } : null;
    });

    await expect(maybeGenerateSlackSessionTitle(baseParams)).resolves.toBe(true);
    expect(patchSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({ preserveActivity: true, readConsistency: "latest" }),
    );
    const patchCall = patchSessionEntry.mock.calls.at(0);
    expect(patchCall).toBeDefined();
    if (!patchCall) {
      throw new Error("expected a session patch call");
    }
    expect(await patchCall[0].update(initial)).toEqual({
      displayName: "Nicholas RFI Filing",
    });

    const concurrentRename = { ...initial, label: "Manual name" };
    expect(await patchCall[0].update(concurrentRename)).toBeNull();
  });

  it("does not generate for an explicitly named session", async () => {
    getSessionEntry.mockReturnValue({
      sessionId: "session-1",
      updatedAt: 1,
      label: "Manual name",
    });

    await expect(maybeGenerateSlackSessionTitle(baseParams)).resolves.toBe(false);
    expect(generateConversationLabel).not.toHaveBeenCalled();
  });

  it("starts generation only after the metadata task settles", async () => {
    let resolveMeta!: () => void;
    const metaTask = new Promise<void>((resolve) => {
      resolveMeta = resolve;
    });
    getSessionEntry.mockReturnValue({ sessionId: "session-1", updatedAt: 1 });
    generateConversationLabel.mockResolvedValue("RFI Filing");
    patchSessionEntry.mockImplementation(async ({ update }) =>
      update({
        sessionId: "session-1",
        updatedAt: 1,
      }),
    );

    scheduleSlackSessionTitleAfterMeta({ ...baseParams, metaTask });
    expect(generateConversationLabel).not.toHaveBeenCalled();
    resolveMeta();
    await vi.waitFor(() => expect(generateConversationLabel).toHaveBeenCalledOnce());
  });
});
