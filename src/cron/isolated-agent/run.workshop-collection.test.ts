import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAdmittedRunActiveAssertion } from "../../agents/admitted-run-context.js";
import {
  runInitialModelFallbackAttempt,
  runFallbackModelAttempt,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import "../../agents/test-helpers/fast-coding-tools.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { WORKSHOP_COLLECTION_REVIEW_MESSAGE } from "../../skills/workshop-host/collection-review-prompt.js";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  resolveEffectiveAgentRuntimeMock,
  runEmbeddedAgentMock,
  runCliAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";
const library = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../../skills/workshop-host/library.js", async (original) => ({
  ...(await original<typeof import("../../skills/workshop-host/library.js")>()),
  listWorkshopSkills: library.list,
}));
const run = await loadRunCronIsolatedAgentTurn();
const cfg = (): OpenClawConfig => ({
  agents: { entries: { main: {} }, defaults: { sandbox: { mode: "off" } } },
  tools: { alsoAllow: ["skill_workshop"] },
  skills: { workshop: { autonomous: { mode: "auto" } } },
});
function input(config = cfg()) {
  return makeIsolatedAgentParamsFixture({
    cfg: config,
    agentId: "main",
    sessionKey: "cron:weekly",
    job: {
      id: "weekly",
      agentId: "main",
      name: "skill-collection-review-main",
      declarationKey: "workshop-collection-review:main",
      enabled: true,
      schedule: { kind: "every", everyMs: 604800000 },
      sessionTarget: "isolated",
      delivery: { mode: "none" },
      payload: {
        kind: "agentTurn",
        message: WORKSHOP_COLLECTION_REVIEW_MESSAGE,
        toolsAllow: ["skill_workshop"],
      },
    },
  });
}
describe("native cron weekly Workshop review", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });
  beforeEach(() => {
    mockRunCronFallbackPassthrough();
    resolveEffectiveAgentRuntimeMock.mockReturnValue("openclaw");
    library.list.mockReset().mockResolvedValue([
      {
        name: "fixture",
        description: "Synthetic procedure",
        files: ["SKILL.md"],
        sizeBytes: 50,
        updatedAtMs: 1,
      },
    ]);
  });
  it("keeps native cron admission while narrowing the actual model run", async () => {
    const result = await run(input());
    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(runCliAgentMock).not.toHaveBeenCalled();
    expect(runEmbeddedAgentMock.mock.calls[0]?.[0]).toMatchObject({
      preparedRunAdmission: expect.any(Object),
      toolsAllow: ["skill_workshop"],
      toolExecutionAllow: ["skill_workshop"],
      conversationToolPolicy: { allow: ["skill_workshop"] },
      contextTokenBudget: 16384,
      streamParams: { maxTokens: 2048 },
      disableMessageTool: true,
      timeoutMs: 120000,
      skillWorkshopReviewOf: expect.any(String),
    });
  });
  it("skips an empty collection before model runtime dispatch", async () => {
    library.list.mockResolvedValue([]);
    expect(await run(input())).toMatchObject({
      status: "skipped",
      summary: expect.stringContaining("empty"),
    });
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });
  it("does not interpret an unreadable collection as empty", async () => {
    library.list.mockRejectedValue(new Error("collection unavailable"));
    const result = await run(input());
    expect(result.status).toBe("error");
    expect(result.error).toContain("collection unavailable");
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });
  it.each(["off", "propose"] as const)("refuses %s before any library/model work", async (mode) => {
    const config = cfg();
    config.skills!.workshop!.autonomous!.mode = mode;
    expect((await run(input(config))).status).toBe("error");
    expect(library.list).not.toHaveBeenCalled();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });
  it("rejects configuration replacement during collection preparation", async () => {
    library.list.mockImplementationOnce(async () => {
      setRuntimeConfigSnapshot({ ...cfg(), skills: { workshop: { autonomous: { mode: "off" } } } });
      return [{ name: "fixture" }];
    });
    expect((await run(input())).status).toBe("error");
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });
  it("applies final provider tool denial to the selected candidate", async () => {
    const config = cfg();
    config.tools = { deny: ["skill_workshop"] };
    expect((await run(input(config))).status).toBe("error");
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });
  it("retains native run authority in the per-write source guard after config revocation", async () => {
    const defaultRun = runEmbeddedAgentMock.getMockImplementation();
    let checked = false;
    runEmbeddedAgentMock.mockImplementationOnce(async (params) => {
      const admitted = await params.preparedRunAdmission.admit("embedded");
      const assertActive = resolveAdmittedRunActiveAssertion(admitted, params.abortSignal);
      expect(assertActive).toBeTypeOf("function");
      assertActive!();
      setRuntimeConfigSnapshot({
        ...cfg(),
        skills: { workshop: { autonomous: { mode: "propose" } } },
      });
      expect(() => assertActive!()).toThrow();
      checked = true;
      return await defaultRun!(params);
    });
    await run(input());
    expect(checked).toBe(true);
  });

  it("runs a supported fallback after the primary runtime cannot enforce the host tool surface", async () => {
    resolveEffectiveAgentRuntimeMock.mockImplementation(({ modelId }) =>
      modelId === "supported" ? "openclaw" : "unavailable-review-runtime",
    );
    runWithModelFallbackMock.mockImplementationOnce(async (params) => {
      await expect(runInitialModelFallbackAttempt(params)).rejects.toThrow("no-rooted-runtime");
      const result = await runFallbackModelAttempt(
        params,
        params.provider,
        "supported",
        "model_not_found",
      );
      return { result, provider: params.provider, model: "supported", attempts: [] };
    });
    expect((await run(input())).status).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedAgentMock.mock.calls[0]?.[0].model).toBe("supported");
  });
});
