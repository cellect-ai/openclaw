// Matrix tests cover handler block streaming configuration behavior.
import { expect, it, vi } from "vitest";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";

export function registerMatrixBlockStreamingConfigTests() {
  it.each<{
    name: string;
    streaming: "off" | "partial" | "quiet";
    blockStreamingEnabled?: boolean;
    disableBlockStreaming: boolean;
  }>([
    {
      name: "keeps final-only delivery when draft streaming is off by default",
      streaming: "off",
      disableBlockStreaming: true,
    },
    {
      name: "keeps block streaming disabled when partial previews are on and block streaming is off",
      streaming: "partial",
      disableBlockStreaming: true,
    },
    {
      name: "keeps block streaming disabled when quiet previews are on and block streaming is off",
      streaming: "quiet",
      disableBlockStreaming: true,
    },
    {
      name: "allows shared block streaming when partial previews and block streaming are both enabled",
      streaming: "partial",
      blockStreamingEnabled: true,
      disableBlockStreaming: false,
    },
    {
      name: "uses shared block streaming when explicitly enabled for Matrix",
      streaming: "off",
      blockStreamingEnabled: true,
      disableBlockStreaming: false,
    },
  ])("$name", async ({ streaming, blockStreamingEnabled, disableBlockStreaming }) => {
    let capturedDisableBlockStreaming: boolean | undefined;

    const { handler } = createMatrixHandlerTestHarness({
      streaming,
      ...(blockStreamingEnabled === undefined ? {} : { blockStreamingEnabled }),
      dispatchInboundMessage: vi.fn(
        async (args: { replyOptions?: { disableBlockStreaming?: boolean } }) => {
          capturedDisableBlockStreaming = args.replyOptions?.disableBlockStreaming;
          return { queuedFinal: false, counts: { final: 0, block: 0, tool: 0 } };
        },
      ) as never,
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({ eventId: "$msg1", body: "hello" }),
    );

    expect(capturedDisableBlockStreaming).toBe(disableBlockStreaming);
  });
}
