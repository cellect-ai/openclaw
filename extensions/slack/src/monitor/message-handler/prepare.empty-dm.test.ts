// A human who DMs a bot and gets nothing at all has no way to tell a refusal
// from an outage. `drop("empty-content")` was one such path: named, but with no
// turn, no reply and no warning behind it.
//
// The standing suspicion was that an image-only DM vanishes there. It does not:
// a downloadable file becomes a media placeholder, and a file that cannot be
// read still renders an "unavailable" line, so both reach the agent. What does
// render nothing is a forward carrying no text of its own, and a DM whose only
// content is a non-shared attachment — Slack's `attachments` text is read for
// bot senders only. Run these against the code before the notice below and the
// three "tells the sender" cases fail with zero replies: that is the silent
// drop, reproduced.
import type { App } from "@slack/bolt";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../../types.js";
import { clearSlackPendingMentionsForTest } from "../unanswered-mentions.js";
import { prepareSlackMessage } from "./prepare.js";
import { createInboundSlackTestContext, createSlackTestAccount } from "./prepare.test-helpers.js";

const { upsertChannelPairingRequestMock } = vi.hoisted(() => ({
  upsertChannelPairingRequestMock: vi.fn(),
}));

const mediaFetchMock = vi.hoisted(() =>
  vi.fn<typeof import("../media.runtime.js").fetchWithRuntimeDispatcher>(),
);

vi.mock("../media.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../media.runtime.js")>()),
  fetchWithRuntimeDispatcher: mediaFetchMock,
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>()),
  upsertChannelPairingRequest: upsertChannelPairingRequestMock,
}));

const account = createSlackTestAccount();

function createDirectMessage(overrides: Partial<SlackMessageEvent>): SlackMessageEvent {
  return {
    channel: "D123",
    channel_type: "im",
    user: "U1",
    text: "",
    ts: "1000.000",
    ...overrides,
  } as SlackMessageEvent;
}

function createHarness(options?: { defaultRequireMention?: boolean }) {
  const postMessage = vi.fn().mockResolvedValue({ ok: true });
  const ctx = createInboundSlackTestContext({
    cfg: { channels: { slack: { enabled: true } } } as OpenClawConfig,
    appClient: { chat: { postMessage } } as unknown as App["client"],
    ...(options?.defaultRequireMention === undefined
      ? {}
      : { defaultRequireMention: options.defaultRequireMention }),
  });
  ctx.resolveUserName = async () => ({ name: "Alice" });
  return {
    ctx,
    postMessage,
    prepare: (message: SlackMessageEvent) =>
      prepareSlackMessage({ ctx, account, message, opts: { source: "message" } }),
  };
}

describe("a direct message that renders no content", () => {
  beforeEach(() => {
    upsertChannelPairingRequestMock.mockReset().mockResolvedValue({ code: "ABCD", created: true });
    mediaFetchMock.mockReset().mockResolvedValue(
      new Response(Buffer.from("image data"), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
  });

  afterEach(() => {
    clearSlackPendingMentionsForTest();
  });

  // The hypothesis under test: an image-only DM vanishes while a text DM is
  // answered. It does not — a downloadable file becomes a media placeholder,
  // and a file that cannot be read still renders an "unavailable" line.
  it("still produces a turn for an image-only DM", async () => {
    const { prepare, postMessage } = createHarness();

    const prepared = await prepare(
      createDirectMessage({
        files: [
          {
            id: "F1",
            name: "site-photo.png",
            mimetype: "image/png",
            url_private: "https://files.slack.com/site-photo.png",
          },
        ],
      }),
    );

    expect(prepared).not.toBeNull();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("still produces a turn for an image-only DM whose file cannot be downloaded", async () => {
    mediaFetchMock.mockResolvedValue(new Response("Not Found", { status: 404 }));
    const { prepare, postMessage } = createHarness();

    const prepared = await prepare(
      createDirectMessage({
        files: [
          {
            id: "F2",
            name: "site-photo.png",
            mimetype: "image/png",
            url_private: "https://files.slack.com/missing.png",
          },
        ],
      }),
    );

    expect(prepared).not.toBeNull();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("still produces a turn for a forwarded DM that carries text", async () => {
    const { prepare, postMessage } = createHarness();

    const prepared = await prepare(
      createDirectMessage({
        attachments: [
          {
            is_share: true,
            author_name: "Matteo",
            text: "the draw package is short a lien waiver",
          },
        ],
      }),
    );

    expect(prepared).not.toBeNull();
    expect(postMessage).not.toHaveBeenCalled();
  });

  // This is the cold case. A forward with no text of its own, no image and no
  // file renders nothing, so the DM reaches `empty-content` and produces no
  // turn. Before the notice below, that was the whole of what happened.
  it("tells the sender when a forward-only DM renders nothing", async () => {
    const { prepare, postMessage } = createHarness();

    const prepared = await prepare(
      createDirectMessage({
        attachments: [{ is_share: true, author_name: "Matteo" }],
      }),
    );

    expect(prepared).toBeNull();
    expect(postMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        channel: "D123",
        text: expect.stringContaining("couldn’t read that message"),
      }),
    );
  });

  // Slack's own `attachments` text is deliberately unused for a human sender,
  // so a DM carrying only a legacy attachment renders empty too.
  it("tells the sender when a DM carries only non-shared attachment text", async () => {
    const { prepare, postMessage } = createHarness();

    const prepared = await prepare(
      createDirectMessage({
        attachments: [{ text: "please review the attached" }],
      }),
    );

    expect(prepared).toBeNull();
    expect(postMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ channel: "D123" }),
    );
  });

  it("answers a repeat sender at most once an hour", async () => {
    const { prepare, postMessage } = createHarness();
    const emptyForward = (ts: string) =>
      createDirectMessage({ ts, attachments: [{ is_share: true, author_name: "Matteo" }] });

    await prepare(emptyForward("1000.000"));
    await prepare(emptyForward("1001.000"));
    await prepare(emptyForward("1002.000"));

    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("leaves an unreadable room message silent, since the room can see it", async () => {
    const { prepare, postMessage } = createHarness({ defaultRequireMention: false });

    const prepared = await prepare(
      createDirectMessage({
        channel: "C123",
        channel_type: "channel",
        attachments: [{ is_share: true, author_name: "Matteo" }],
      }),
    );

    expect(prepared).toBeNull();
    expect(postMessage).not.toHaveBeenCalled();
  });
});
