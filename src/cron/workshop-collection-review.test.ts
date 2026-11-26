import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronServiceContract } from "./service-contract.js";
import type { CronJob } from "./types.js";
const mocks = vi.hoisted(() => ({
  harness: vi.fn(),
  candidates: vi.fn(),
  policy: vi.fn(),
  sessions: vi.fn(),
}));
vi.mock("../agents/harness/registry.js", () => ({ getRegisteredAgentHarness: mocks.harness }));
vi.mock("../agents/model-fallback-candidates.js", () => ({
  resolveModelCandidateChain: mocks.candidates,
}));
vi.mock("../agents/harness/availability.js", () => ({
  resolveAvailableAgentHarnessPolicy: mocks.policy,
}));
vi.mock("../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: () => [],
}));
vi.mock("../config/sessions/session-accessor.js", () => ({
  readSessionEntriesFromStoreInWorker: mocks.sessions,
}));
import { WORKSHOP_COLLECTION_REVIEW_MESSAGE } from "../skills/workshop-host/collection-review.js";
import {
  hasEligibleSkillCollectionReviewRuntime,
  reconcileWorkshopCollectionReviews,
  WORKSHOP_COLLECTION_REVIEW_EVERY_MS,
} from "./workshop-collection-review.js";

const config = (mode: "auto" | "propose" | "off" = "auto"): OpenClawConfig => ({
  agents: { entries: { main: { model: "fixture/model" } } },
  skills: { workshop: { autonomous: { mode } } },
});
function fixture(jobs: CronJob[] = []) {
  return {
    cfg: config(),
    cron: {
      list: vi.fn<CronServiceContract["list"]>(async () => jobs),
      add: vi.fn<CronServiceContract["add"]>(async () => jobs[0]!),
      update: vi.fn<CronServiceContract["update"]>(async () => jobs[0]!),
    },
    enabled: true,
    isCurrent: () => true,
    logger: { warn: vi.fn() },
  };
}
function existing(enabled = true): CronJob {
  return {
    id: "original",
    agentId: "main",
    name: "skill-collection-review-main",
    declarationKey: "workshop-collection-review:main",
    enabled,
    schedule: { kind: "every", everyMs: WORKSHOP_COLLECTION_REVIEW_EVERY_MS, anchorMs: 12345 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "agentTurn",
      message: WORKSHOP_COLLECTION_REVIEW_MESSAGE,
      toolsAllow: ["skill_workshop"],
    },
    delivery: { mode: "none" },
    createdAtMs: 1,
    updatedAtMs: 2,
    state: {},
  };
}
beforeEach(() => {
  mocks.harness.mockImplementation((id: string) =>
    id === "external" ? { harness: {} } : undefined,
  );
  mocks.candidates.mockReturnValue([{ provider: "fixture", model: "model" }]);
  mocks.policy.mockReturnValue({ runtime: "openclaw", runtimeSource: "model" });
  mocks.sessions.mockResolvedValue({ entries: [] });
});
afterEach(() => vi.resetAllMocks());
describe("weekly Workshop declaration", () => {
  it.each(["auto", "propose", "off"] as const)(
    "projects %s through native declarations with no other scheduler",
    async (mode) => {
      const f = fixture();
      f.cfg = config(mode);
      await reconcileWorkshopCollectionReviews(f);
      expect(f.cron.add).toHaveBeenCalledWith(
        expect.objectContaining({
          declarationKey: "workshop-collection-review:main",
          enabled: mode === "auto",
          schedule: expect.objectContaining({ everyMs: 604800000 }),
          payload: expect.objectContaining({ toolsAllow: ["skill_workshop"] }),
          idleOnly: true,
          delivery: { mode: "none" },
        }),
        expect.objectContaining({ systemOwned: true, commitGuard: expect.any(Function) }),
      );
    },
  );
  it("preserves migrated anchors and an explicit disabled intent", async () => {
    const f = fixture([existing(false)]);
    await reconcileWorkshopCollectionReviews(f);
    expect(f.cron.add.mock.calls[0]?.[0]).toMatchObject({
      enabled: false,
      schedule: { anchorMs: 12345 },
    });
  });
  it.each(["no-rooted-runtime", "no-workshop-tools"] as const)(
    "shows %s and restores policy-disabled jobs when eligibility returns",
    async (reason) => {
      const f = fixture();
      if (reason === "no-rooted-runtime")
        mocks.policy.mockReturnValue({ runtime: "external", runtimeSource: "model" });
      else f.cfg.tools = { deny: ["skill_workshop"] };
      await reconcileWorkshopCollectionReviews(f);
      expect(f.cron.add.mock.calls[0]?.[0]).toMatchObject({
        enabled: false,
        displayName: `[${reason}] Skill collection review (main)`,
      });
      const next = existing(false);
      next.displayName = `[${reason}] Skill collection review (main)`;
      const resumed = fixture([next]);
      mocks.policy.mockReturnValue({ runtime: "codex", runtimeSource: "model" });
      await reconcileWorkshopCollectionReviews(resumed);
      expect(resumed.cron.add.mock.calls[0]?.[0]).toMatchObject({ enabled: true });
    },
  );
  it("keeps a supported fallback eligible and leaves unknown or persisted choices to execution", async () => {
    mocks.candidates.mockReturnValue([
      { provider: "fixture", model: "bad" },
      { provider: "fixture", model: "good" },
    ]);
    mocks.policy.mockImplementation(({ modelId }) => ({
      runtime: modelId === "good" ? "codex" : "external",
      runtimeSource: "model",
    }));
    expect(hasEligibleSkillCollectionReviewRuntime(config(), "main", [])).toBe(true);
    mocks.candidates.mockReturnValue([]);
    expect(hasEligibleSkillCollectionReviewRuntime(config(), "main", [])).toBeUndefined();
    mocks.candidates.mockReturnValue([{ provider: "fixture", model: "bad" }]);
    mocks.sessions.mockResolvedValue({
      entries: [
        { sessionKey: "agent:main:cron:original", entry: { agentRuntimeOverride: "codex" } },
      ],
    });
    const f = fixture([existing()]);
    await reconcileWorkshopCollectionReviews(f);
    expect(f.cron.add.mock.calls[0]?.[0]).toMatchObject({ enabled: true });
  });
  it("warns when cron is disabled and rejects stale reconciliation at native mutation", async () => {
    const f = fixture();
    f.enabled = false;
    await reconcileWorkshopCollectionReviews(f);
    expect(f.logger.warn).toHaveBeenCalledWith(expect.stringContaining("no separate timer"));
    let current = true;
    const stale = fixture();
    stale.isCurrent = () => current;
    stale.cron.list.mockImplementationOnce(async () => {
      current = false;
      return [];
    });
    await expect(reconcileWorkshopCollectionReviews(stale)).rejects.toThrow("superseded");
    expect(stale.cron.add).not.toHaveBeenCalled();
  });
});
