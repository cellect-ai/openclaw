// Covers the core notice that makes a DM access request visible without plugins.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loggerMocks = vi.hoisted(() => ({
  warn: vi.fn<(message: string) => void>(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    warn: loggerMocks.warn,
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  onChannelPairingRequested,
  recordChannelPairingRequested,
  resetChannelPairingRequestedListeners,
} from "./pairing-request-notice.js";

beforeEach(() => {
  loggerMocks.warn.mockClear();
  resetChannelPairingRequestedListeners();
});

afterEach(() => {
  resetChannelPairingRequestedListeners();
});

describe("recordChannelPairingRequested", () => {
  it("warns with the account, sender and the command that reviews it", () => {
    recordChannelPairingRequested({
      channel: "slack",
      accountId: "fi-user",
      senderId: "U123",
    });

    expect(loggerMocks.warn).toHaveBeenCalledTimes(1);
    const message = loggerMocks.warn.mock.calls[0]?.[0] ?? "";
    expect(message).toContain("slack:fi-user");
    expect(message).toContain("U123");
    expect(message).toContain("openclaw pairing list --channel slack --account fi-user");
  });

  it("keeps the pairing code out of the log", () => {
    recordChannelPairingRequested({
      channel: "slack",
      accountId: "fi-user",
      senderId: "U123",
      metadata: { code: "SECRET12", username: "gc" },
    });

    const message = loggerMocks.warn.mock.calls[0]?.[0] ?? "";
    expect(message).not.toContain("SECRET12");
  });

  it("notifies registered core listeners", () => {
    const seen: string[] = [];
    const dispose = onChannelPairingRequested((notice) => seen.push(notice.senderId));
    try {
      recordChannelPairingRequested({ channel: "telegram", senderId: "42" });
    } finally {
      dispose();
    }
    recordChannelPairingRequested({ channel: "telegram", senderId: "43" });

    expect(seen).toEqual(["42"]);
  });

  it("does not let a failing listener hide the request from the others", () => {
    const seen: string[] = [];
    const disposeFailing = onChannelPairingRequested(() => {
      throw new Error("listener exploded");
    });
    const disposeWorking = onChannelPairingRequested((notice) => seen.push(notice.senderId));
    try {
      expect(() =>
        recordChannelPairingRequested({ channel: "telegram", senderId: "42" }),
      ).not.toThrow();
    } finally {
      disposeFailing();
      disposeWorking();
    }

    expect(seen).toEqual(["42"]);
  });
});
