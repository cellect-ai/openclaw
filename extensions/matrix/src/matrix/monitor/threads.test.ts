// Matrix tests cover threads plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { resolveMatrixReplyToEventId, resolveMatrixThreadRootId } from "../relations.js";
import { logMatrixInboundRoute, resolveMatrixThreadRouting } from "./threads.js";

describe("resolveMatrixThreadRouting", () => {
  it.each([undefined, false, true])(
    "keeps thread placement independent from reply fallback %s",
    (isFallingBack) => {
      const content = {
        "m.relates_to": {
          rel_type: "m.thread",
          event_id: "$root",
          is_falling_back: isFallingBack,
          "m.in_reply_to": { event_id: "$selected" },
        },
      };
      expect(resolveMatrixThreadRootId(content)).toBe("$root");
      expect(resolveMatrixReplyToEventId(content)).toBe(
        isFallingBack === true ? undefined : "$selected",
      );
    },
  );
  it("keeps sessions flat when threadReplies is off", () => {
    expect(
      resolveMatrixThreadRouting({
        isDirectMessage: false,
        threadReplies: "off",
        messageId: "$reply1",
        threadRootId: "$root",
      }),
    ).toEqual({
      threadId: undefined,
    });
  });

  it("uses the inbound thread root when replies arrive inside an existing thread", () => {
    expect(
      resolveMatrixThreadRouting({
        isDirectMessage: false,
        threadReplies: "inbound",
        messageId: "$reply1",
        threadRootId: "$root",
      }),
    ).toEqual({
      threadId: "$root",
    });
  });

  it("keeps top-level inbound messages flat when threadReplies is inbound", () => {
    expect(
      resolveMatrixThreadRouting({
        isDirectMessage: false,
        threadReplies: "inbound",
        messageId: "$root",
      }),
    ).toEqual({
      threadId: undefined,
    });
  });

  it("uses the triggering message as the thread id when threadReplies is always", () => {
    expect(
      resolveMatrixThreadRouting({
        isDirectMessage: false,
        threadReplies: "always",
        messageId: "$root",
      }),
    ).toEqual({
      threadId: "$root",
    });
  });

  it("lets dm.threadReplies override room threading behavior", () => {
    expect(
      resolveMatrixThreadRouting({
        isDirectMessage: true,
        threadReplies: "always",
        dmThreadReplies: "off",
        messageId: "$reply1",
        threadRootId: "$root",
      }),
    ).toEqual({
      threadId: undefined,
    });
  });
});

describe("logMatrixInboundRoute", () => {
  it("labels a top-level always-thread send as a new root", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    expect(
      logMatrixInboundRoute({
        outcome: "dispatch",
        roomId: "!room:example",
        eventId: "$new",
        accountId: "fi-user",
        isDirectMessage: false,
        threadReplies: "always",
        sessionThreadId: "$new",
        mentioned: true,
      }),
    ).toEqual({ kind: "new_root", mismatch: false });
    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toEqual({
      evt: "matrix.inbound_route",
      outcome: "dispatch",
      roomId: "!room:example",
      eventId: "$new",
      accountId: "fi-user",
      isDirectMessage: false,
      threadRootId: null,
      sessionThreadId: "$new",
      kind: "new_root",
      mentioned: true,
    });
    info.mockRestore();
  });

  it("warns when the session thread disagrees with m.thread and never logs a body", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      logMatrixInboundRoute({
        outcome: "dispatch",
        roomId: "!room:example",
        eventId: "$reply",
        accountId: "fi-admin",
        isDirectMessage: false,
        threadReplies: "always",
        threadRootId: "$root",
        sessionThreadId: "$other",
        mentioned: true,
      }),
    ).toEqual({ kind: "thread", mismatch: true });
    const line = JSON.parse(String(warn.mock.calls[0]?.[0]));
    expect(line).toMatchObject({
      evt: "matrix.inbound_route_mismatch",
      level: "warn",
      threadRootId: "$root",
      sessionThreadId: "$other",
      kind: "thread",
    });
    expect(JSON.stringify([info.mock.calls, warn.mock.calls])).not.toMatch(/body|Please|secret/);
    info.mockRestore();
    warn.mockRestore();
  });
});
