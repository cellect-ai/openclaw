// Tests SQLite-backed pairing store lifecycle and account isolation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";

const pairingMocks = vi.hoisted(() => ({
  getPairingAdapter: vi.fn<
    () => { idLabel: string; normalizeAllowEntry?: (entry: string) => string } | null
  >(() => null),
}));

vi.mock("../channels/plugins/pairing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../channels/plugins/pairing.js")>()),
  getPairingAdapter: pairingMocks.getPairingAdapter,
}));

import { resolvePairingRequestAccountId } from "./pairing-store-keys.js";
import {
  readChannelPairingStateSnapshot,
  writeChannelPairingStateSnapshot,
} from "./pairing-store-sqlite.test-helpers.js";
import {
  approveChannelPairingCode,
  CHANNEL_PAIRING_HISTORY_MAX,
  CHANNEL_PAIRING_PENDING_TTL_MS,
  CHANNEL_PAIRING_STALE_AFTER_MS,
  isPairingRequestStale,
  approveChannelPairingRequest,
  dismissChannelPairingRequest,
  listChannelPairingRequests,
  readChannelAllowFromStore,
  resolveChannelPairingRequestId,
  resolvePairingRequestStatus,
  upsertChannelPairingRequest,
} from "./pairing-store.js";

let fixtureRoot = "";
let caseId = 0;

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pairing-"));
});

afterAll(async () => {
  await closeStateDatabaseForTest();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  pairingMocks.getPairingAdapter.mockReset();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await closeStateDatabaseForTest();
});

function createTestEnv(): { stateDir: string; env: NodeJS.ProcessEnv } {
  const stateDir = path.join(fixtureRoot, `case-${caseId++}`);
  fs.mkdirSync(stateDir, { recursive: true });
  return { stateDir, env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function requireFirstPairingRequest(
  requests: Awaited<ReturnType<typeof listChannelPairingRequests>>,
) {
  expect(requests).toHaveLength(1);
  const request = requests[0];
  if (!request) {
    throw new Error("expected pairing request");
  }
  return request;
}

describe("pairing request retention", () => {
  async function ageRequest(params: { channel: string; env: NodeJS.ProcessEnv; ageMs: number }) {
    const state = readChannelPairingStateSnapshot(params.channel, params.env);
    const agedAt = new Date(Date.now() - params.ageMs).toISOString();
    state.requests = state.requests.map((request) => ({
      ...request,
      createdAt: agedAt,
      lastSeenAt: agedAt,
    }));
    writeChannelPairingStateSnapshot(params.channel, state, params.env);
  }

  it("keeps a request listable well past the retired one-hour window", async () => {
    const { env } = createTestEnv();
    await upsertChannelPairingRequest({
      channel: "demo-ttl",
      id: "gc",
      accountId: DEFAULT_ACCOUNT_ID,
      env,
    });
    await ageRequest({ channel: "demo-ttl", env, ageMs: 6 * 60 * 60 * 1000 });

    const request = requireFirstPairingRequest(await listChannelPairingRequests("demo-ttl", env));
    expect(resolvePairingRequestStatus(request)).toBe("pending");
    expect(CHANNEL_PAIRING_PENDING_TTL_MS).toBeGreaterThan(24 * 60 * 60 * 1000);
  });

  it("shows an expired request as expired instead of dropping it", async () => {
    const { env } = createTestEnv();
    const created = await upsertChannelPairingRequest({
      channel: "demo-expiry",
      id: "gc",
      accountId: DEFAULT_ACCOUNT_ID,
      env,
    });
    await ageRequest({
      channel: "demo-expiry",
      env,
      ageMs: CHANNEL_PAIRING_PENDING_TTL_MS + 60_000,
    });

    const expired = requireFirstPairingRequest(
      await listChannelPairingRequests("demo-expiry", env),
    );
    expect(resolvePairingRequestStatus(expired)).toBe("expired");
    expect(isPairingRequestStale(expired)).toBe(false);

    // An expired code is not approvable; the sender has to ask again.
    await expect(
      approveChannelPairingCode({ channel: "demo-expiry", code: created.code, env }),
    ).resolves.toBeNull();
    await expect(readChannelAllowFromStore("demo-expiry", env)).resolves.toEqual([]);
  });

  it("issues a fresh challenge when a sender asks again after expiry", async () => {
    const { env } = createTestEnv();
    const first = await upsertChannelPairingRequest({
      channel: "demo-revive",
      id: "gc",
      accountId: DEFAULT_ACCOUNT_ID,
      env,
    });
    await ageRequest({
      channel: "demo-revive",
      env,
      ageMs: CHANNEL_PAIRING_PENDING_TTL_MS + 60_000,
    });

    const revived = await upsertChannelPairingRequest({
      channel: "demo-revive",
      id: "gc",
      accountId: DEFAULT_ACCOUNT_ID,
      env,
    });
    // `created` drives the challenge-vs-reminder decision, so an aged-out
    // request must read as new rather than reusing a code nobody can approve.
    expect(revived.created).toBe(true);
    expect(revived.code).not.toBe(first.code);

    const request = requireFirstPairingRequest(
      await listChannelPairingRequests("demo-revive", env),
    );
    expect(resolvePairingRequestStatus(request)).toBe("pending");
    await expect(
      approveChannelPairingCode({ channel: "demo-revive", code: revived.code, env }),
    ).resolves.toMatchObject({ id: "gc" });
  });

  it("keeps reusing one pending request so a repeat sender is reminded, not re-challenged", async () => {
    const { env } = createTestEnv();
    const first = await upsertChannelPairingRequest({
      channel: "demo-repeat",
      id: "gc",
      accountId: DEFAULT_ACCOUNT_ID,
      env,
    });
    await ageRequest({ channel: "demo-repeat", env, ageMs: 2 * 60 * 60 * 1000 });
    const repeat = await upsertChannelPairingRequest({
      channel: "demo-repeat",
      id: "gc",
      accountId: DEFAULT_ACCOUNT_ID,
      env,
    });

    expect(repeat).toEqual({ code: first.code, created: false });
    expect(await listChannelPairingRequests("demo-repeat", env)).toHaveLength(1);
  });

  it("marks a long-unanswered pending request stale", async () => {
    const { env } = createTestEnv();
    await upsertChannelPairingRequest({
      channel: "demo-stale",
      id: "gc",
      accountId: DEFAULT_ACCOUNT_ID,
      env,
    });
    const fresh = requireFirstPairingRequest(await listChannelPairingRequests("demo-stale", env));
    expect(isPairingRequestStale(fresh)).toBe(false);

    await ageRequest({
      channel: "demo-stale",
      env,
      ageMs: CHANNEL_PAIRING_STALE_AFTER_MS + 60_000,
    });
    const stale = requireFirstPairingRequest(await listChannelPairingRequests("demo-stale", env));
    expect(isPairingRequestStale(stale)).toBe(true);
    expect(resolvePairingRequestStatus(stale)).toBe("pending");
  });

  it("retains history without spending a pending slot", async () => {
    const { env } = createTestEnv();
    for (const id of ["one", "two", "three"]) {
      await upsertChannelPairingRequest({
        channel: "demo-slots",
        id,
        accountId: DEFAULT_ACCOUNT_ID,
        env,
      });
    }
    await expect(
      upsertChannelPairingRequest({
        channel: "demo-slots",
        id: "four",
        accountId: DEFAULT_ACCOUNT_ID,
        env,
      }),
    ).resolves.toEqual({ code: "", created: false });

    const pending = await listChannelPairingRequests("demo-slots", env);
    const dismissed = pending[0];
    if (!dismissed) {
      throw new Error("expected a pending request");
    }
    await expect(
      dismissChannelPairingRequest({
        channel: "demo-slots",
        accountId: DEFAULT_ACCOUNT_ID,
        requestId: resolveChannelPairingRequestId("demo-slots", dismissed),
        env,
      }),
    ).resolves.toMatchObject({ id: dismissed.id });

    // The dismissed record stays visible, and its slot is free again.
    await expect(
      upsertChannelPairingRequest({
        channel: "demo-slots",
        id: "four",
        accountId: DEFAULT_ACCOUNT_ID,
        env,
      }),
    ).resolves.toMatchObject({ created: true });
    const all = await listChannelPairingRequests("demo-slots", env);
    expect(all).toHaveLength(4);
    expect(
      all.filter((request) => resolvePairingRequestStatus(request) === "dismissed"),
    ).toHaveLength(1);
  });

  it("keeps retained history isolated per account", async () => {
    const { env } = createTestEnv();
    await upsertChannelPairingRequest({
      channel: "telegram",
      accountId: "alpha",
      id: "outsider",
      env,
    });
    await upsertChannelPairingRequest({
      channel: "telegram",
      accountId: "beta",
      id: "outsider",
      env,
    });
    const alpha = requireFirstPairingRequest(
      await listChannelPairingRequests("telegram", env, "alpha"),
    );
    await expect(
      approveChannelPairingRequest({
        channel: "telegram",
        accountId: "alpha",
        requestId: resolveChannelPairingRequestId("telegram", alpha),
        env,
      }),
    ).resolves.toMatchObject({ id: "outsider" });

    const alphaHistory = await listChannelPairingRequests("telegram", env, "alpha");
    const betaHistory = await listChannelPairingRequests("telegram", env, "beta");
    expect(alphaHistory.map((request) => resolvePairingRequestStatus(request))).toEqual([
      "approved",
    ]);
    // One tenant's approval must not resolve or expose the other's request.
    expect(betaHistory.map((request) => resolvePairingRequestStatus(request))).toEqual(["pending"]);
    await expect(readChannelAllowFromStore("telegram", env, "beta")).resolves.toEqual([]);
  });

  it("bounds retained history per account", async () => {
    const { env } = createTestEnv();
    for (let index = 0; index < CHANNEL_PAIRING_HISTORY_MAX + 3; index += 1) {
      await upsertChannelPairingRequest({
        channel: "demo-history",
        id: `sender-${index}`,
        accountId: DEFAULT_ACCOUNT_ID,
        env,
      });
      const target = (await listChannelPairingRequests("demo-history", env)).find(
        (request) => resolvePairingRequestStatus(request) === "pending",
      );
      if (!target) {
        throw new Error("expected a pending request");
      }
      await dismissChannelPairingRequest({
        channel: "demo-history",
        accountId: DEFAULT_ACCOUNT_ID,
        requestId: resolveChannelPairingRequestId("demo-history", target),
        env,
      });
    }
    const retained = await listChannelPairingRequests("demo-history", env);
    expect(retained).toHaveLength(CHANNEL_PAIRING_HISTORY_MAX);
  });
});
