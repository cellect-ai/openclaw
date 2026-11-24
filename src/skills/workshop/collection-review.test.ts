import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ harness: vi.fn(), profile: vi.fn(), available: vi.fn() }));
vi.mock("../../agents/harness/registry.js", () => ({ getRegisteredAgentHarness: mocks.harness }));
vi.mock("../../agents/conversation-capability-profile.js", () => ({
  prepareConversationCapabilityProfile: mocks.profile,
}));
vi.mock("./tool-policy-diagnostic.js", () => ({
  resolveSkillWorkshopToolPolicyAvailability: mocks.available,
}));
import {
  prepareWorkshopCollectionCandidate,
  supportsWorkshopCollectionRuntime,
} from "./collection-review.js";
beforeEach(() => {
  mocks.profile.mockResolvedValue({});
  mocks.available.mockReturnValue({ available: true });
});
afterEach(() => vi.resetAllMocks());
const request = () => ({
  config: {},
  agentId: "main",
  provider: "fixture",
  model: "model",
  runtime: "openclaw",
  cliExecution: false,
  sessionKey: "agent:main:cron:weekly",
  workspaceDir: "/synthetic",
  sandboxed: false,
  assertCurrent: vi.fn(),
});
it("defers unknown projections and admits only a loaded exact tool-policy owner at execution", async () => {
  expect(supportsWorkshopCollectionRuntime("new-runtime")).toBeUndefined();
  await expect(
    prepareWorkshopCollectionCandidate({ ...request(), runtime: "new-runtime" }),
  ).rejects.toThrow("no-rooted-runtime");
  mocks.harness.mockReturnValue({ harness: { conversationToolPolicySupport: "exact" } });
  await expect(
    prepareWorkshopCollectionCandidate({ ...request(), runtime: "new-runtime" }),
  ).resolves.toBeUndefined();
  expect(mocks.profile).toHaveBeenCalledOnce();
});
it.each(["cli", "sandbox", "tool-denied"] as const)(
  "refuses %s before model dispatch",
  async (kind) => {
    const params = request();
    if (kind === "cli") params.cliExecution = true;
    if (kind === "sandbox") params.sandboxed = true;
    if (kind === "tool-denied") mocks.available.mockReturnValue({ available: false });
    await expect(prepareWorkshopCollectionCandidate(params)).rejects.toThrow(
      kind === "cli" ? "no-rooted-runtime" : "no-workshop-tools",
    );
  },
);
it("rechecks the exact source after asynchronous candidate policy preparation", async () => {
  let live = true;
  mocks.profile.mockImplementationOnce(async () => {
    live = false;
    return {};
  });
  await expect(
    prepareWorkshopCollectionCandidate({
      ...request(),
      assertCurrent() {
        if (!live) throw new Error("run retired");
      },
    }),
  ).rejects.toThrow("run retired");
  expect(mocks.available).not.toHaveBeenCalled();
});
