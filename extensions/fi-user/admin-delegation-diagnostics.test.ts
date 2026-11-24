import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installDelegationFixtures,
  BROKER,
  TOKEN,
  MATRIX_SESSION,
  matrix,
  THREAD,
  thread,
  SANDBOXED,
  plugin,
  mints,
} from "./admin-delegation.test-helpers.js";

installDelegationFixtures();

describe("opt-in admin delegation diagnostics", () => {
  const runId = "00000000-0000-4000-8000-000000000001";
  const selected = { ...SANDBOXED, diagnostics: { flags: [`fi-user.admin-delegation.${runId}`] } };
  const diagnostics = (turn: ReturnType<typeof plugin>) =>
    turn.info.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_DIAGNOSTICS", "");
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
  });

  it("records nothing by default while preserving token delivery", async () => {
    const turn = plugin();
    await turn.arrive(matrix.arrive);
    await turn.start({ ...matrix.start, runId });
    expect((await turn.exec({ ...matrix.exec, runId }))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(
      TOKEN,
    );
    expect(turn.info).not.toHaveBeenCalled();
    expect(turn.diagnosticRunContextSize()).toBe(0);
  });

  it.each([
    "*",
    "all",
    "fi-user.*",
    "fi-user.admin-delegation.*",
    "fi-user.admin-delegation.session.*",
  ])("does not treat the broad flag %s as exact-run consent", async (flag) => {
    vi.stubEnv("OPENCLAW_DIAGNOSTICS", "*");
    const turn = plugin({}, { ...SANDBOXED, diagnostics: { flags: [flag] } });
    await turn.arrive(matrix.arrive);
    await turn.start({ ...matrix.start, runId });
    expect((await turn.exec({ ...matrix.exec, runId }))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(
      TOKEN,
    );
    expect(turn.info).not.toHaveBeenCalled();
  });

  it("selects a known native session before its run UUID exists and delivers at most two records", async () => {
    const hash = createHash("sha256").update(MATRIX_SESSION.toLowerCase()).digest("hex");
    const turn = plugin(
      {},
      {
        ...SANDBOXED,
        diagnostics: { flags: [`fi-user.admin-delegation.session.${hash}`] },
      },
    );
    await turn.arrive(matrix.arrive);
    await turn.start({ ...matrix.start, runId });
    for (let call = 0; call < 3; call++) {
      expect(
        (await turn.exec({ ...matrix.exec, runId }))?.params?.env?.FI_DELEGATED_USER_TOKEN,
      ).toBe(TOKEN);
    }
    await turn.start({ ...matrix.start, runId });
    expect(diagnostics(turn).map((row) => row.reason)).toEqual(["turn-admitted", "mint-issued"]);
    expect(JSON.stringify(diagnostics(turn))).not.toContain(hash);
    turn.info.mockClear();
    await turn.start({
      ...matrix.start,
      runId: "00000000-0000-4000-8000-000000000002",
      sessionKey: THREAD,
    });
    await turn.exec({
      ...matrix.exec,
      runId: "00000000-0000-4000-8000-000000000002",
      sessionKey: THREAD,
    });
    expect(turn.info).not.toHaveBeenCalled();
  });

  it("explains an unmatched native event without granting a token or exposing values", async () => {
    const turn = plugin({}, selected);
    await turn.arrive(matrix.arrive);
    await turn.start({
      ...matrix.start,
      runId,
      channelContext: {
        ...matrix.start.channelContext,
        chat: { id: "!dm:matrix.example", eventId: "$different-event" },
      },
    });
    expect(
      (await turn.exec({ ...matrix.exec, runId }))?.params.env?.FI_DELEGATED_USER_TOKEN,
    ).toBeUndefined();
    expect(mints()).toHaveLength(0);
    const rows = diagnostics(turn);
    expect(rows).toEqual([
      expect.objectContaining({
        runId,
        reason: "turn-unproven",
        dispatchProven: true,
        originEventMatches: false,
      }),
      expect.objectContaining({
        runId,
        reason: "mint-run-unproven",
        runPresent: true,
        runAdmitted: false,
      }),
    ]);
    for (const row of rows) {
      expect(row.event).toBe("fi-user.admin-delegation");
      for (const [key, value] of Object.entries(row)) {
        if (!["event", "runId", "reason"].includes(key)) {
          expect(typeof value).toBe("boolean");
        }
      }
    }
    const serialized = JSON.stringify(rows);
    for (const privateValue of [
      TOKEN,
      BROKER,
      "@admin:matrix.example",
      MATRIX_SESSION,
      "$event",
      "$different-event",
      "npm run fi:audit",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("selects only the configured run and preserves successful admission", async () => {
    const turn = plugin({}, selected);
    await turn.arrive(matrix.arrive);
    await turn.start({ ...matrix.start, runId });
    expect((await turn.exec({ ...matrix.exec, runId }))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(
      TOKEN,
    );
    expect(diagnostics(turn).map((row) => row.reason)).toEqual(["turn-admitted", "mint-issued"]);
    turn.info.mockClear();
    await turn.exec({ ...matrix.exec, runId: "00000000-0000-4000-8000-000000000002" });
    expect(turn.info).not.toHaveBeenCalled();
  });

  it("preserves the current owner's admitted voice run with diagnostics enabled", async () => {
    const turn = plugin({}, selected);
    await turn.start({
      ...thread().start,
      runId,
      channelContext: {
        sender: { id: "@admin:matrix.example" },
        chat: { id: "!room:matrix.example", talkThreadRootEventId: "$root" },
      },
    });
    expect(
      (await turn.exec({ ...thread().exec, runId }))?.params.env?.FI_DELEGATED_USER_TOKEN,
    ).toBe(TOKEN);
    expect(diagnostics(turn)).toEqual([
      expect.objectContaining({ reason: "turn-admitted", voiceTurn: true, ownerAdmitted: true }),
      expect.objectContaining({ reason: "mint-issued" }),
    ]);
    expect(JSON.stringify(diagnostics(turn))).not.toContain("@admin:matrix.example");
  });

  it("does not turn logger failure into a token refusal", async () => {
    const turn = plugin({}, selected);
    turn.info.mockImplementation(() => {
      throw new Error("fixture logging unavailable");
    });
    await turn.arrive(matrix.arrive);
    await turn.start({ ...matrix.start, runId });
    expect((await turn.exec({ ...matrix.exec, runId }))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(
      TOKEN,
    );
  });
});
