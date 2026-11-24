import { createHash } from "node:crypto";
import { importPluginStateEntriesForDoctorForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useNoticeStores } from "./admin-action-notice.test-support.js";
import { sendSlackNotice } from "./admin-action-slack-publish.js";
import { cfg, harness, ORG, origin, REQUESTER } from "./admin-action-slack.test-support.js";
import { resolveFiUserPluginConfig } from "./fi-delegation.js";
import { NOTICE_COOLDOWN_MS, NOTICE_WINDOW_MS, type NoticeClaim } from "./notice-operation-api.js";

const open = useNoticeStores();
const config = resolveFiUserPluginConfig(cfg.plugins.entries["fi-user"].config);
const countPrefix = `count:${ORG}:${REQUESTER}:`;
const claim = (id: string, digest = id): NoticeClaim => ({
  countPrefix,
  dedupeKey: `dedupe:${ORG}:${REQUESTER}:${digest}`,
  countKey: `${countPrefix}0:${id}`,
  claimId: id,
});
const writes = { writeStores: [0], watchStores: [] };

beforeEach(() => {
  vi.stubEnv("SLACK_APPROVAL_TEST_BROKER", "test-broker");
});

describe("native Slack notice admission", () => {
  it("admits only one of two distinct notices at the deployed legacy count boundary", async () => {
    const { store } = open();
    for (let n = 0; n < 4; n++) {
      await store.register(
        `${countPrefix}legacy-${n}`,
        { at: Date.now() },
        { ttlMs: NOTICE_WINDOW_MS },
      );
    }
    const h = harness(null, {}, store);
    const results = await Promise.all(
      ["First", "Second"].map((description) =>
        sendSlackNotice(h.api, config, origin, { label: "Document", description }, () => {}),
      ),
    );
    expect(results.map((result) => result.administratorsNotified).sort()).toEqual([0, 2]);
    expect(h.sendText).toHaveBeenCalledTimes(2);
    expect(
      (await store.entries()).filter((entry) => entry.key.startsWith(countPrefix)),
    ).toHaveLength(5);
  });

  it("keeps legacy dedupe and count expiry unchanged and admits after already expired rows", async () => {
    const { options, store, operation } = open();
    const now = Date.now();
    const live = claim("live");
    const expired = claim("expired");
    importPluginStateEntriesForDoctorForTests("fi-user", options, [
      {
        key: live.countKey,
        value: { at: now - 10_000 },
        createdAt: now - 10_000,
        ttlMs: NOTICE_WINDOW_MS,
      },
      {
        key: live.dedupeKey,
        value: { at: now - 10_000 },
        createdAt: now - 10_000,
        ttlMs: NOTICE_COOLDOWN_MS,
      },
      // Native import measures a row's TTL from the import, not from createdAt, so a
      // legacy row past its window is modelled by a TTL that has already run out.
      {
        key: expired.countKey,
        value: { at: now - NOTICE_WINDOW_MS - 1 },
        createdAt: now - NOTICE_WINDOW_MS - 1,
        ttlMs: 1,
      },
      {
        key: expired.dedupeKey,
        value: { at: now - NOTICE_COOLDOWN_MS - 1 },
        createdAt: now - NOTICE_COOLDOWN_MS - 1,
        ttlMs: 1,
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (let n = 0; n < 3; n++) {
      await store.register(
        `${countPrefix}other-live-${n}`,
        { at: now },
        { ttlMs: NOTICE_WINDOW_MS },
      );
    }
    const before = (await store.entries()).filter(
      (entry) => entry.key === live.countKey || entry.key === live.dedupeKey,
    );
    expect((await operation.execute({ type: "claim", input: live }, writes)).value).toEqual({
      ok: false,
      reason: "duplicate",
    });
    expect((await operation.execute({ type: "claim", input: expired }, writes)).value).toEqual({
      ok: true,
    });
    expect(
      (await store.entries()).filter(
        (entry) => entry.key === live.countKey || entry.key === live.dedupeKey,
      ),
    ).toEqual(before);
    const admitted = (await store.entries()).filter(
      (entry) => entry.key === expired.countKey || entry.key === expired.dedupeKey,
    );
    expect(
      admitted.find((entry) => entry.key === expired.countKey)!.expiresAt! -
        admitted.find((entry) => entry.key === expired.countKey)!.createdAt,
    ).toBe(NOTICE_WINDOW_MS);
    expect(
      admitted.find((entry) => entry.key === expired.dedupeKey)!.expiresAt! -
        admitted.find((entry) => entry.key === expired.dedupeKey)!.createdAt,
    ).toBe(NOTICE_COOLDOWN_MS);
  });

  it("admits identical concurrent notices once", async () => {
    const { store } = open();
    const h = harness(null, {}, store);
    const notice = { label: "Document", description: "same" };
    const results = await Promise.all(
      Array.from({ length: 3 }, () => sendSlackNotice(h.api, config, origin, notice, () => {})),
    );
    expect(results.map((result) => result.administratorsNotified).sort()).toEqual([0, 0, 2]);
    expect(h.sendText).toHaveBeenCalledTimes(2);
    expect(await store.entries()).toHaveLength(2);
  });

  it("releases count and dedupe together only when no reviewer accepted a send", async () => {
    const { store } = open();
    const h = harness(null, {}, store);
    h.sendText.mockRejectedValue(new Error("all sends failed"));
    await expect(
      sendSlackNotice(
        h.api,
        config,
        origin,
        { label: "Document", description: "private" },
        () => {},
      ),
    ).rejects.toThrow(/could not be notified/);
    expect(h.sendText).toHaveBeenCalledTimes(2);
    expect(await store.entries()).toEqual([]);
  });

  it("rolls back both admission rows when the second write exceeds native capacity", async () => {
    const { store, operation } = open(1);
    const input = claim("full");
    await expect(operation.execute({ type: "claim", input }, writes)).rejects.toThrow();
    expect(await store.lookup(input.dedupeKey)).toBeUndefined();
    expect(await store.lookup(input.countKey)).toBeUndefined();
  });

  it("releases only this attempt's rows and never a successor or deployed legacy owner", async () => {
    const { store, operation } = open();
    const first = claim("first", "same");
    expect((await operation.execute({ type: "claim", input: first }, writes)).value).toEqual({
      ok: true,
    });
    await store.register(first.dedupeKey, { at: Date.now(), claimId: "successor" });
    await operation.execute({ type: "release", input: first }, writes);
    expect(await store.lookup(first.countKey)).toBeUndefined();
    expect(await store.lookup(first.dedupeKey)).toMatchObject({ claimId: "successor" });
    await store.register(first.dedupeKey, { at: 123 });
    await operation.execute({ type: "release", input: first }, writes);
    expect(await store.lookup(first.dedupeKey)).toEqual({ at: 123 });
  });

  it("rejects revoked caller authority before worker admission and sends nothing", async () => {
    const { store } = open();
    const h = harness(null, {}, store);
    await expect(
      sendSlackNotice(h.api, config, origin, { label: "Document", description: "private" }, () => {
        throw new Error("revoked");
      }),
    ).rejects.toThrow("revoked");
    expect(await store.entries()).toEqual([]);
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it("preserves the claim after partial delivery so retry never duplicates accepted notices", async () => {
    const { store } = open();
    const h = harness(null, {}, store);
    h.sendText.mockRejectedValueOnce(new Error("first reviewer unavailable"));
    const notice = { label: "Document", description: "private" };
    expect(await sendSlackNotice(h.api, config, origin, notice, () => {})).toMatchObject({
      administratorsNotified: 1,
    });
    expect(await sendSlackNotice(h.api, config, origin, notice, () => {})).toMatchObject({
      administratorsNotified: 0,
    });
    expect(h.sendText).toHaveBeenCalledTimes(2);
    const digest = createHash("sha256").update("Document\nprivate").digest("hex").slice(0, 32);
    expect(await store.lookup(`dedupe:${ORG}:${REQUESTER}:${digest}`)).toBeDefined();
  });
});
