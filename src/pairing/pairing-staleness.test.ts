// Covers the escalation that makes an unanswered DM access request louder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../channels/plugins/pairing.js", () => ({
  getPairingAdapter: vi.fn(() => null),
  listPairingChannels: vi.fn(() => []),
}));

import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { sweepStalePairingRequests } from "./pairing-staleness.js";
import {
  readChannelPairingStateSnapshot,
  writeChannelPairingStateSnapshot,
} from "./pairing-store-sqlite.test-helpers.js";
import { CHANNEL_PAIRING_STALE_AFTER_MS, upsertChannelPairingRequest } from "./pairing-store.js";

let fixtureRoot = "";
let caseId = 0;

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pairing-stale-"));
});

afterAll(() => {
  closeOpenClawStateDatabaseForTest();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

function createTestEnv(): NodeJS.ProcessEnv {
  const stateDir = path.join(fixtureRoot, `case-${caseId++}`);
  fs.mkdirSync(stateDir, { recursive: true });
  return { ...process.env, OPENCLAW_STATE_DIR: stateDir };
}

async function seedRequest(params: {
  env: NodeJS.ProcessEnv;
  channel: string;
  accountId: string;
  senderId: string;
  ageMs: number;
}) {
  await upsertChannelPairingRequest({
    channel: params.channel,
    id: params.senderId,
    accountId: params.accountId,
    env: params.env,
  });
  if (params.ageMs <= 0) {
    return;
  }
  const state = readChannelPairingStateSnapshot(params.channel, params.env);
  const agedAt = new Date(Date.now() - params.ageMs).toISOString();
  state.requests = state.requests.map((request) =>
    request.id === params.senderId
      ? { ...request, createdAt: agedAt, lastSeenAt: agedAt }
      : request,
  );
  writeChannelPairingStateSnapshot(params.channel, state, params.env);
}

describe("sweepStalePairingRequests", () => {
  it("stays quiet about a request that is merely waiting", async () => {
    const env = createTestEnv();
    await seedRequest({ env, channel: "slack", accountId: "fi-user", senderId: "U1", ageMs: 0 });
    const warn = vi.fn<(message: string) => void>();

    await expect(
      sweepStalePairingRequests({ channels: ["slack"], env, log: { warn } }),
    ).resolves.toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns with the age and the command that clears it", async () => {
    const env = createTestEnv();
    await seedRequest({
      env,
      channel: "slack",
      accountId: "fi-user",
      senderId: "U1",
      ageMs: CHANNEL_PAIRING_STALE_AFTER_MS + 3 * 60 * 60 * 1000,
    });
    const warn = vi.fn<(message: string) => void>();

    await expect(
      sweepStalePairingRequests({ channels: ["slack"], env, log: { warn } }),
    ).resolves.toBe(1);
    const message = warn.mock.calls[0]?.[0] ?? "";
    expect(message).toContain("27h");
    expect(message).toContain("slack:fi-user");
    expect(message).toContain("U1");
    expect(message).toContain("openclaw pairing list --channel slack --account fi-user");
  });

  it("keeps escalating for as long as the request goes unanswered", async () => {
    const env = createTestEnv();
    await seedRequest({
      env,
      channel: "slack",
      accountId: "fi-user",
      senderId: "U1",
      ageMs: CHANNEL_PAIRING_STALE_AFTER_MS + 60_000,
    });
    const warn = vi.fn<(message: string) => void>();

    await sweepStalePairingRequests({ channels: ["slack"], env, log: { warn } });
    await sweepStalePairingRequests({ channels: ["slack"], env, log: { warn } });

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("does not escalate an expired or resolved request", async () => {
    const env = createTestEnv();
    await seedRequest({
      env,
      channel: "slack",
      accountId: "fi-user",
      senderId: "U1",
      ageMs: 400 * 24 * 60 * 60 * 1000,
    });
    const warn = vi.fn<(message: string) => void>();

    await expect(
      sweepStalePairingRequests({ channels: ["slack"], env, log: { warn } }),
    ).resolves.toBe(0);
  });

  it("reports every tenant's stale request without merging them", async () => {
    const env = createTestEnv();
    for (const accountId of ["fi-user", "fi-admin"]) {
      await seedRequest({
        env,
        channel: "slack",
        accountId,
        senderId: `U-${accountId}`,
        ageMs: CHANNEL_PAIRING_STALE_AFTER_MS + 60_000,
      });
    }
    const warn = vi.fn<(message: string) => void>();

    await expect(
      sweepStalePairingRequests({ channels: ["slack"], env, log: { warn } }),
    ).resolves.toBe(2);
    const messages = warn.mock.calls.map((call) => call[0]).join("\n");
    expect(messages).toContain("slack:fi-user");
    expect(messages).toContain("slack:fi-admin");
  });
});
