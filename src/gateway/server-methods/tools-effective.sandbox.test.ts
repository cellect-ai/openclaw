import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyFinalEffectiveToolPolicy } from "../../agents/embedded-agent-runner/effective-tool-policy.js";
import { makeProviderModelFixture } from "../../agents/test-helpers/provider-model-fixture.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { toolsEffectiveHandlers, testing } from "./tools-effective.js";

type InventoryModule = typeof import("../../agents/tools-effective-inventory.js");
type AcquiredContext = Awaited<
  ReturnType<InventoryModule["acquireEffectiveToolInventoryRuntimeModelContext"]>
>;
type ModelContext = Parameters<Parameters<AcquiredContext["run"]>[0]>[0];
const mocks = vi.hoisted(() => ({
  load: vi.fn<typeof import("../session-utils.js").loadGatewaySessionEntryReadOnly>(),
  inventory: vi.fn<InventoryModule["resolveEffectiveToolInventory"]>(),
}));

vi.mock("../session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils.js")>()),
  loadGatewaySessionEntryReadOnly: mocks.load,
  resolveSessionModelRef: () => ({ provider: "openai", model: "gpt-4.1" }),
}));
vi.mock("../../agents/tools-effective-inventory.js", async (importOriginal) => ({
  ...(await importOriginal<InventoryModule>()),
  resolveEffectiveToolInventory: mocks.inventory,
  acquireEffectiveToolInventoryRuntimeModelContext: async () => ({
    run: (project: (context: ModelContext) => unknown) =>
      project({
        modelApi: "openai-responses",
        runtimeModel: makeProviderModelFixture({
          id: "gpt-4.1",
          name: "GPT 4.1",
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          contextWindow: 128_000,
          maxTokens: 8_192,
        }),
      }),
    [Symbol.asyncDispose]: async () => {},
  }),
}));

const key = "agent:main:matrix:channel:!fixture:example.test:thread:$root";
function setSession(cfg: OpenClawConfig, override: Partial<SessionEntry> = {}) {
  mocks.load.mockReturnValue({
    cfg,
    agentId: "main",
    storePath: "/fixture/sessions.sqlite",
    canonicalKey: key,
    store: {},
    storeKeys: [key],
    legacyKey: undefined,
    entry: { sessionId: "fixture-session", updatedAt: 1, ...override },
  });
}
async function invoke() {
  const respond = vi.fn();
  await expectDefined(
    toolsEffectiveHandlers["tools.effective"],
    "registered inventory handler",
  )({
    params: { sessionKey: key },
    respond: respond as never,
    context: { getRuntimeConfig: () => ({}) } as never,
    client: null,
    req: { type: "req", id: "fixture", method: "tools.effective" },
    isWebchatConnect: () => false,
  });
  expect(respond.mock.calls[0]?.[0]).toBe(true);
  const payload = respond.mock.calls[0]?.[1] as { groups: Array<{ tools: Array<{ id: string }> }> };
  return payload.groups.flatMap((group) => group.tools).some((tool) => tool.id === "ask_user");
}

describe("tools.effective sandbox admission parity", () => {
  beforeEach(() => {
    mocks.load.mockReset();
    mocks.inventory.mockReset();
    testing.resetToolsEffectiveCacheForTest();
    mocks.inventory.mockImplementation((params) => {
      const tools = applyFinalEffectiveToolPolicy({
        bundledTools: [
          {
            name: "ask_user",
            label: "Ask",
            description: "Question",
            parameters: { type: "object", properties: {} },
            execute: async () => ({ content: [] }),
          },
        ],
        config: params.cfg,
        conversationCapabilityProfile: expectDefined(
          params.conversationCapabilityProfile,
          "prepared session policy",
        ),
        warn: () => {},
      });
      return {
        agentId: "main",
        profile: "full",
        groups: [
          {
            id: "core",
            label: "Core",
            source: "core",
            tools: tools.map((tool) => ({
              id: tool.name,
              label: "Ask",
              description: "Question",
              rawDescription: "Question",
              source: "core",
            })),
          },
        ],
      };
    });
  });

  it.each([
    { mode: "all", sandboxMode: undefined, required: false, allowed: false },
    { mode: "off", sandboxMode: undefined, required: false, allowed: true },
    { mode: "all", sandboxMode: "off", required: false, allowed: true },
    { mode: "off", sandboxMode: "off", required: true, allowed: false },
  ] as const)(
    "mode=$mode override=$sandboxMode required=$required",
    async ({ mode, sandboxMode, required, allowed }) => {
      setSession(
        { agents: { defaults: { sandbox: { mode } } } },
        { sandboxMode, ...(required ? { sandbox: "required" } : {}) },
      );
      expect(await invoke()).toBe(allowed);
      // The canonical session was already prepared; policy classification must
      // not perform another lookup or activate a sandbox.
      expect(mocks.load).toHaveBeenCalledTimes(1);
    },
  );

  it("invalidates cached policy after admission changes without a new session", async () => {
    setSession({ agents: { defaults: { sandbox: { mode: "all" } } } });
    expect(await invoke()).toBe(false);
    setSession({
      agents: { defaults: { sandbox: { mode: "all" } } },
      tools: { sandbox: { tools: { alsoAllow: ["ask_user"] } } },
    });
    expect(await invoke()).toBe(true);
    expect(mocks.inventory).toHaveBeenCalledTimes(2);
  });

  it("invalidates cached policy when only the persisted session sandbox mode changes", async () => {
    const cfg: OpenClawConfig = { agents: { defaults: { sandbox: { mode: "all" } } } };
    setSession(cfg);
    expect(await invoke()).toBe(false);
    setSession(cfg, { sandboxMode: "off" });
    expect(await invoke()).toBe(true);
    expect(mocks.inventory).toHaveBeenCalledTimes(2);
  });
});
