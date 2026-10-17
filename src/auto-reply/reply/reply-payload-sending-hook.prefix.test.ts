import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginHookReplyPayloadSendingEvent } from "../../plugins/hook-types.js";
import { createHookRunner } from "../../plugins/hooks.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-helpers.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { preparedReplyPublication, resolveReplyPublication } from "../reply-publication.js";
import { normalizeReplyPayload } from "./normalize-reply.js";
import { runReplyPayloadSendingHook } from "./reply-payload-sending-hook.js";

const prefix = "<@U123>";
function normalized(text = "The answer", responsePrefix = prefix) {
  const payload = normalizeReplyPayload(
    { text, mediaUrl: "https://example.test/file" },
    { responsePrefix },
  );
  if (!payload) throw new Error("fixture unexpectedly suppressed");
  return payload;
}

describe("host prefix policy at the modifying hook boundary", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps a wrapper outside host addressing when a later policy times out", async () => {
    vi.useFakeTimers();
    const finish = createDeferredCore();
    const entered = createDeferredCore();
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "reply_payload_sending",
          priority: 10,
          handler: (event) => {
            const current = event as PluginHookReplyPayloadSendingEvent;
            return { payload: { ...current.payload, text: `Notice: ${current.payload.text}` } };
          },
        },
        {
          hookName: "reply_payload_sending",
          timeoutMs: 10,
          handler: async (event) => {
            resolveReplyPublication(event)?.deferSynthesizedPrefix?.();
            entered.resolve();
            await finish.promise;
          },
        },
      ]),
      { logger: { error: vi.fn(), warn: vi.fn() } },
    );
    const pending = runReplyPayloadSendingHook(
      { payload: normalized(), kind: "final", context: { channelId: "slack" } },
      runner,
    );
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(10);
      expect((await pending)?.text).toBe("Notice: The answer");
    } finally {
      finish.resolve();
      await pending;
    }
  });

  it.each(["released", "empty", "cancelled", "forged"] as const)(
    "preserves the %s hook outcome",
    async (outcome) => {
      const payload = normalized();
      const runner = createHookRunner(
        createMockPluginRegistry([
          {
            hookName: "reply_payload_sending",
            handler: (event) => {
              if (outcome === "released")
                resolveReplyPublication(event)?.deferSynthesizedPrefix?.()();
              if (outcome === "empty")
                return { payload: { text: "", mediaUrl: "https://example.test/file" } };
              if (outcome === "cancelled") return { cancel: true };
              if (outcome === "forged") {
                const clone = JSON.parse(JSON.stringify(event));
                expect(resolveReplyPublication(clone)).toBeUndefined();
              }
            },
          },
        ]),
      );
      const result = await runReplyPayloadSendingHook(
        { payload, kind: "final", context: { channelId: "slack" } },
        runner,
      );
      if (outcome === "cancelled") expect(result).toBeNull();
      else expect(result?.text).toBe(outcome === "empty" ? "" : `${prefix} The answer`);
    },
  );

  it("applies a different prefix on later normalization without inventing a policy hold", () => {
    expect(normalizeReplyPayload(normalized(), { responsePrefix: "Other" })?.text).toBe(
      `Other ${prefix} The answer`,
    );
  });

  it.each(["error", "timeout"] as const)(
    "keeps a withheld prefix absent after hook %s",
    async (failure) => {
      vi.useFakeTimers();
      const finish = createDeferredCore();
      const entered = createDeferredCore();
      let release: (() => void) | undefined;
      const runner = createHookRunner(
        createMockPluginRegistry([
          {
            hookName: "reply_payload_sending",
            timeoutMs: 10,
            handler: async (event) => {
              release = resolveReplyPublication(event)?.deferSynthesizedPrefix?.();
              entered.resolve();
              if (failure === "error") throw new Error("private authority unavailable");
              await finish.promise;
              release?.();
            },
          },
        ]),
        { logger: { error: vi.fn(), warn: vi.fn() } },
      );
      const pending = runReplyPayloadSendingHook(
        {
          payload: normalized(),
          kind: "final",
          channel: "slack",
          context: { channelId: "slack" },
        },
        runner,
      );
      try {
        await entered.promise;
        if (failure === "timeout") await vi.advanceTimersByTimeAsync(10);
        const result = await pending;
        expect(result?.text).toBe("The answer");
        expect(result?.mediaUrl).toBe("https://example.test/file");
        expect(preparedReplyPublication(result)).not.toHaveProperty("synthesizedPrefix");
        expect(preparedReplyPublication(result)).not.toHaveProperty("deferSynthesizedPrefix");
        // A late policy response cannot restore bytes in an already admitted reply.
        release?.();
        finish.resolve();
        expect(result && normalizeReplyPayload(result, { responsePrefix: prefix })?.text).toBe(
          "The answer",
        );
      } finally {
        finish.resolve();
        await pending;
      }
    },
  );

  it("keeps independent holds and never treats model-authored mention bytes as a host prefix", async () => {
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "reply_payload_sending",
          handler: (event) => {
            const publication = resolveReplyPublication(event);
            const release = publication?.deferSynthesizedPrefix?.();
            publication?.deferSynthesizedPrefix?.();
            release?.();
          },
        },
      ]),
    );
    for (const [payload, expected] of [
      [normalized(), "The answer"],
      [normalized(`${prefix} model text`), `${prefix} model text`],
    ] as const) {
      const result = await runReplyPayloadSendingHook(
        { payload, kind: "final", channel: "slack", context: { channelId: "slack" } },
        runner,
      );
      expect(result?.text).toBe(expected);
    }
  });
});
