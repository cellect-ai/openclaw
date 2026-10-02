import { afterEach, describe, expect, it, vi } from "vitest";
import { logTalkJoin, sessionThreadIdFromKey, talkClientJoin } from "./talk-join-log.js";

describe("talk join-key logs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the Matrix thread suffix from a session key", () => {
    expect(
      sessionThreadIdFromKey(
        "agent:cellect-main:matrix:group:!yZwsiSwxlOT6JaVC8Q:matrix.cellect.ai:thread:$8jVLk5D8d2h7rOm9JrKNmjOy9ZlkFM3dRnM7NzXEcyA",
      ),
    ).toBe("$8jVLk5D8d2h7rOm9JrKNmjOy9ZlkFM3dRnM7NzXEcyA");
    expect(sessionThreadIdFromKey("agent:cellect-main:matrix:group:!room:matrix.cellect.ai")).toBe(
      undefined,
    );
    expect(sessionThreadIdFromKey("agent:x:matrix:group:!room:s:thread:")).toBeUndefined();
  });

  it("prefers connect.client.id over the paired device id", () => {
    expect(
      talkClientJoin({
        pairedClientId: "openclaw-control-ui",
        connect: { client: { id: "openclaw-control-ui", mode: "webchat" } },
      }),
    ).toEqual({ client: "openclaw-control-ui", clientMode: "webchat" });
    expect(talkClientJoin({ pairedClientId: "ios" })).toEqual({ client: "ios", clientMode: null });
  });

  it("writes JSON stdout and warns only on mismatch, without bodies or tokens", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logTalkJoin("talk.session_create", {
      bound: false,
      speaker: false,
      roomId: "!room:matrix.cellect.ai",
      threadRootEventId: "$root",
      sessionThreadId: "$root",
      client: "openclaw-control-ui",
    });
    logTalkJoin(
      "talk.consult",
      {
        speaker: false,
        roomId: null,
        sessionThreadId: "$root",
        hasChannelContext: false,
      },
      "no_matrix_route",
    );
    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toEqual({
      evt: "talk.session_create",
      bound: false,
      speaker: false,
      roomId: "!room:matrix.cellect.ai",
      threadRootEventId: "$root",
      sessionThreadId: "$root",
      client: "openclaw-control-ui",
    });
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      evt: "talk.consult",
      mismatch: "no_matrix_route",
      level: "warn",
    });
    expect(JSON.stringify([info.mock.calls, warn.mock.calls])).not.toMatch(/binding|Please|secret/);
  });
});
