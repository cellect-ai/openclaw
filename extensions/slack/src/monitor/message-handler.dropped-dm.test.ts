// A flush whose every entry was already claimed ends without a turn. That is
// correct — another owner is answering it — but it used to return in silence,
// and a DM that ends in silence is indistinguishable from one that was lost.
import { createTestInboundDebounceFlush } from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it, vi } from "vitest";

type InboundDebounceFlush = { admission: Promise<void>; completion: Promise<void> };

const warn = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  const logger = { warn, info: () => {}, child: () => logger };
  return { ...actual, createSubsystemLogger: () => logger };
});

const enqueueMock = vi.fn(async (_entry: unknown) => {});
const onFlushCallbacks: Array<
  (
    entries: Array<Record<string, unknown>>,
    createFlush: typeof createTestInboundDebounceFlush,
  ) => InboundDebounceFlush
> = [];
const prepareSlackMessageMock = vi.fn(async () => ({ ctxPayload: {} }));
const dispatchPreparedSlackMessageMock = vi.fn(async (_prepared: unknown) => {});

vi.mock("openclaw/plugin-sdk/channel-inbound", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
    "openclaw/plugin-sdk/channel-inbound",
  );
  return {
    ...actual,
    createChannelInboundDebouncer: (
      params: Parameters<typeof actual.createChannelInboundDebouncer<Record<string, unknown>>>[0],
    ) => {
      onFlushCallbacks.push(params.onFlush);
      return {
        debounceMs: 10,
        debouncer: {
          enqueue: (entry: unknown) => enqueueMock(entry),
          flushKey: async () => {},
          cancelKey: () => false,
          drain: async () => {},
        },
      };
    },
  };
});

vi.mock("./thread-resolution.js", () => ({
  createSlackThreadTsResolver: () => ({
    resolve: (entry: { message: Record<string, unknown> }) => ({ ...entry.message }),
  }),
}));

vi.mock("./message-handler/pipeline.runtime.js", () => ({
  prepareSlackMessage: prepareSlackMessageMock,
  dispatchPreparedSlackMessage: dispatchPreparedSlackMessageMock,
}));

const { createSlackRuntimeContextReader } = await import("./runtime-policy.js");
const { createSlackMessageHandler } = await import("./message-handler.js");

function runOnFlush(entries: Array<Record<string, unknown>>): Promise<void> {
  const flush = onFlushCallbacks[0]?.(entries, createTestInboundDebounceFlush);
  if (!flush) {
    throw new Error("Slack inbound debounce callback missing");
  }
  return flush.completion;
}

describe("a Slack flush that produces no dispatchable message", () => {
  it("says so, and names the DM it ended", async () => {
    const log = vi.fn();
    const ctx = {
      installationIdentity: { kind: "degraded", reason: "auth_test_failed" },
      cfg: {},
      accountId: "default",
      app: { client: {} },
      runtime: { log },
      rememberSlackChannelType: () => {},
    } as unknown as Parameters<typeof createSlackMessageHandler>[0]["ctx"];
    ctx.readRuntimeContext = createSlackRuntimeContextReader(ctx, "synthetic-lookup");
    const handler = createSlackMessageHandler({ ctx });
    const directMessage = {
      type: "message" as const,
      channel: "D222",
      channel_type: "im" as const,
      user: "U0GC",
      ts: "1709000000.000700",
      text: "is the draw package out?",
    };

    await handler(directMessage as never, { source: "message" });
    await runOnFlush([enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>]);
    await handler(directMessage as never, { source: "message" });
    await runOnFlush([enqueueMock.mock.calls[1]?.[0] as Record<string, unknown>]);

    // The message is answered exactly once, and the second flush is recorded
    // rather than dropped without a word.
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        "slack inbound flush produced no dispatchable message account=default channel=D222 ts=1709000000.000700 entries=1 reason=dispatch-claimed-elsewhere",
      ),
    );
    expect(warn).toHaveBeenCalledWith(
      "Dropped direct message account=default channel=D222 user=U0GC ts=1709000000.000700 reason=dispatch-claimed-elsewhere",
    );
  });
});
