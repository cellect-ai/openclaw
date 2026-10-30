import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../../packages/gateway-protocol/src/index.js";
import { forgetUnifiedTalkSession, rememberUnifiedTalkSession } from "../session-registry.js";

const announce = vi.hoisted(() => vi.fn(() => "accepted"));
vi.mock("../relay/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../relay/index.js")>()),
  announceTalkRealtimeRelayAnswer: announce,
}));

const { talkSessionHandlers } = await import("./session.js");

async function callAnnounce(params: Record<string, unknown>, connId = "conn-1") {
  const respond = vi.fn();
  await talkSessionHandlers["talk.session.announce"]!({
    req: { type: "req", id: "1", method: "talk.session.announce" },
    params,
    client: { connId } as never,
    isWebchatConnect: () => false,
    respond: respond as never,
    context: {} as never,
  });
  return respond.mock.calls[0] as [
    boolean,
    unknown,
    { code?: string; message?: string; retryable?: boolean; details?: unknown }?,
  ];
}

describe("talk.session.announce", () => {
  afterEach(() => {
    forgetUnifiedTalkSession("talk-1");
    forgetUnifiedTalkSession("stt-1");
    announce.mockReset().mockReturnValue("accepted");
  });

  function rememberRelay() {
    rememberUnifiedTalkSession("talk-1", {
      kind: "realtime-relay",
      connId: "conn-1",
      relaySessionId: "relay-1",
      sessionTarget: {} as never,
    });
  }

  it("hands the owner's trimmed answer to the relay and answers ok", async () => {
    rememberRelay();

    const [ok, payload] = await callAnnounce({ sessionId: "talk-1", text: "  Funded Tuesday.\n" });

    expect(ok).toBe(true);
    expect(payload).toEqual({ ok: true });
    expect(announce).toHaveBeenCalledExactlyOnceWith({
      relaySessionId: "relay-1",
      connId: "conn-1",
      text: "Funded Tuesday.",
    });
  });

  it("answers an unknown session like its sibling methods", async () => {
    const [ok, , error] = await callAnnounce({ sessionId: "missing", text: "answer" });

    expect(ok).toBe(false);
    expect(error).toMatchObject({ code: ErrorCodes.UNAVAILABLE });
    expect(error?.message).toContain("Unknown Talk session");
    expect(announce).not.toHaveBeenCalled();
  });

  it("refuses a connection that does not own the session", async () => {
    rememberRelay();

    const [ok, , error] = await callAnnounce({ sessionId: "talk-1", text: "answer" }, "conn-2");

    expect(ok).toBe(false);
    expect(error?.message).toContain("Talk session is not owned by this connection");
    expect(announce).not.toHaveBeenCalled();
  });

  it.each([
    ["blank text", { sessionId: "talk-1", text: "   " }],
    ["text over 16000 characters", { sessionId: "talk-1", text: "a".repeat(16_001) }],
    ["missing text", { sessionId: "talk-1" }],
    ["only framing markers", { sessionId: "talk-1", text: "<<ANSWER>> <<END ANSWER>>" }],
  ])("rejects %s", async (_label, params) => {
    rememberRelay();

    const [ok, , error] = await callAnnounce(params);

    expect(ok).toBe(false);
    expect(error).toMatchObject({ code: ErrorCodes.INVALID_REQUEST });
    expect(announce).not.toHaveBeenCalled();
  });

  it("tells a client the provider cannot announce, so it can fall back", async () => {
    rememberRelay();
    announce.mockReturnValue("unsupported");

    const [ok, , error] = await callAnnounce({ sessionId: "talk-1", text: "answer" });

    expect(ok).toBe(false);
    expect(error).toMatchObject({
      code: ErrorCodes.INVALID_REQUEST,
      details: { code: "announce_unsupported" },
    });
  });

  it("does not answer ok when the voice is not accepting input", async () => {
    rememberRelay();
    announce.mockReturnValue("unavailable");

    const [ok, , error] = await callAnnounce({ sessionId: "talk-1", text: "answer" });

    expect(ok).toBe(false);
    expect(error).toMatchObject({ code: ErrorCodes.UNAVAILABLE, retryable: true });
  });

  it("rejects a session without a realtime voice", async () => {
    rememberUnifiedTalkSession("stt-1", {
      kind: "transcription-relay",
      connId: "conn-1",
      transcriptionSessionId: "stt-1",
    });

    const [ok, , error] = await callAnnounce({ sessionId: "stt-1", text: "answer" });

    expect(ok).toBe(false);
    expect(error).toMatchObject({ code: ErrorCodes.INVALID_REQUEST });
    expect(announce).not.toHaveBeenCalled();
  });
});
