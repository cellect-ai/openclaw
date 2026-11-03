// Keep cold handler imports outside the in-process request deadline.
import "../gateway/server-methods/sessions-mutations.js";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import * as configRuntime from "../config/config.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createRequestGatewayMethodRegistry } from "../gateway/server-methods.js";
import { createModelsListTestContext } from "../gateway/server-methods/models-list-result.openai-routes.test-support.js";
import { flushPendingSessionsChangedEvents } from "../gateway/server-methods/session-change-event.js";
import {
  disposeSessionReadContexts,
  initializeSessionReadContext,
} from "../gateway/server-methods/sessions-read-cache.test-support.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { withOperatorToolGatewayAuthority } from "../gateway/server-plugin-in-process-dispatch.js";
import { createGatewayRequestContext } from "../gateway/server-request-context.js";
import { makeContextParams } from "../gateway/server-request-context.test-support.js";
import { sharingPolicyClient } from "../gateway/session-sharing.test-utils.js";
import type { WorkerSessionPlacementRecord } from "../gateway/worker-environments/placement-record.js";
import { registerInternalHook, unregisterInternalHook } from "../hooks/internal-hooks.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { registerAgentHarness } from "./harness/registry.js";
import type { AgentHarness } from "./harness/types.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import * as preparedCatalog from "./prepared-model-catalog.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";
import {
  callAgentToolGatewayRequest,
  type AgentToolGatewayRequestCaller,
} from "./tools/in-process-gateway.js";
import { createSessionStatusTool } from "./tools/session-status-tool.js";

const runtime = vi.hoisted(() => ({
  prepare: vi.fn<typeof import("./model-runtime-choice.js").preparePublishedModelRuntimeChoice>(),
  thinkingCatalog: vi.fn(),
}));
vi.mock("./model-runtime-choice.js", () => ({
  preparePublishedModelRuntimeChoice: runtime.prepare,
}));
vi.mock("./model-catalog.runtime.js", () => ({
  loadProviderScopedThinkingCatalog: runtime.thinkingCatalog,
}));
vi.mock("../status/status-text.js", () => ({ buildStatusText: async () => "Session status" }));

const catalog: ModelCatalogEntry[] = [
  { provider: "fixture", id: "default", name: "Default", reasoning: false },
  { provider: "fixture", id: "chosen", name: "Chosen", reasoning: false },
  {
    provider: "fixture",
    id: "native",
    name: "Native",
    reasoning: false,
    nativeRuntime: "status-native",
  },
];
const nativeHarness: AgentHarness = {
  id: "status-native",
  label: "Status native fixture",
  executionEnvironment: "host-only",
  supports: () => ({ supported: true }),
  async runAttempt() {
    throw new Error("Model selection must not start a turn");
  },
};
const originalRegistry = getActivePluginRegistry();
const onPatch = vi.fn();
let state: OpenClawTestState;
let cfg: OpenClawConfig;
let nextSession = 0;

function modelConfig(
  entries: ModelCatalogEntry[],
  selection: Pick<
    NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>,
    "model" | "models" | "modelPolicy"
  >,
): OpenClawConfig {
  return {
    agents: {
      entries: { main: {}, support: {} },
      defaults: {
        ...selection,
        modelSelectionScope: "global",
        sandbox: { mode: "off", sessionToolsVisibility: "all" },
      },
    },
    models: {
      providers: {
        fixture: {
          api: "openai-completions",
          baseUrl: "https://fixture.invalid/v1",
          agentRuntime: { id: "openclaw" },
          models: entries.map<ModelDefinitionConfig>((entry) => ({
            id: entry.id,
            name: entry.name,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            maxTokens: 1024,
          })),
        },
      },
    },
  };
}

beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
});
beforeEach(() => {
  cfg = modelConfig(catalog, {
    model: { primary: "fixture/default", fallbacks: ["fixture/chosen"] },
    models: {
      "fixture/default": {},
      "fixture/chosen": { alias: "chosen" },
      "fixture/native": {},
    },
  });
  configRuntime.setRuntimeConfigSnapshot(cfg);
  setActivePluginRegistry(createEmptyPluginRegistry(), "status-model-test", "default");
  registerAgentHarness(nativeHarness);
  vi.spyOn(preparedCatalog, "loadPublishedPreparedModelCatalog").mockResolvedValue(catalog);
  runtime.prepare.mockReset().mockResolvedValue({
    kind: "ready",
    runtimeId: nativeHarness.id,
    harness: nativeHarness,
    validate: () => undefined,
  });
  runtime.thinkingCatalog.mockReset().mockResolvedValue(catalog);
  onPatch.mockReset();
  registerInternalHook("session:patch", onPatch);
});
afterEach(async () => {
  await flushPendingSessionsChangedEvents();
  await disposeSessionReadContexts();
  unregisterInternalHook("session:patch", onPatch);
  vi.restoreAllMocks();
  if (originalRegistry) {
    setActivePluginRegistry(originalRegistry, "status-model-test-restore", "default");
  } else {
    resetPluginRuntimeStateForTest();
  }
});
afterAll(async () => {
  await state.cleanup();
});

async function fixture(
  options: {
    agentId?: string;
    sessionKey?: string;
    entry?: Partial<SessionEntry>;
    sessionEntry?: SessionEntry;
    catalog?: ModelCatalogEntry[];
    observeGateway?: boolean;
  } = {},
) {
  const agentId = options.agentId ?? "main";
  const id = `status-selection-${++nextSession}`;
  const key = options.sessionKey ?? `agent:${agentId}:${id}`;
  const scope = { agentId, sessionKey: key };
  await upsertSessionEntryCore(
    scope,
    options.sessionEntry ?? {
      sessionId: id,
      lifecycleRevision: `${id}-generation`,
      updatedAt: 1,
      permissionMode: "full",
      sandboxMode: "off",
      ...options.entry,
    },
  );
  const broadcast = vi.fn<GatewayRequestContext["broadcastToConnIds"]>();
  const modelContext = createModelsListTestContext({
    cfg,
    agentId,
    agentDir: state.agentDir(agentId),
    workspaceDir: state.workspaceDir,
    catalog: options.catalog ?? catalog,
    catalogComplete: true,
    preparedAuthModes: { fixture: "api_key" },
    preparedAuthStore: { version: 1, profiles: {} },
  });
  const context = createGatewayRequestContext(
    makeContextParams({
      getAttachedGatewayMethodRegistry: createRequestGatewayMethodRegistry,
      broadcastToConnIds: broadcast,
      loadGatewayModelCatalogSnapshot: modelContext.loadGatewayModelCatalogSnapshot,
    }),
  );
  let current = true;
  const resolveGatewayContext = () => (current ? context : undefined);
  context.resolveGatewayContext = resolveGatewayContext;
  context.getSessionEventSubscriberConnIds = () => new Set(["status-observer"]);
  await initializeSessionReadContext(context);
  const gatewayCalls: Array<{
    request: Parameters<AgentToolGatewayRequestCaller>[0];
    result: Promise<unknown>;
  }> = [];
  const observeGateway: AgentToolGatewayRequestCaller = <T>(
    request: Parameters<AgentToolGatewayRequestCaller>[0],
  ) => {
    const result = callAgentToolGatewayRequest<T>(request);
    gatewayCalls.push({ request, result });
    return result;
  };
  const tool = createSessionStatusTool({
    config: cfg,
    agentSessionKey: key,
    requesterAgentIdOverride: agentId,
    ...(options.observeGateway ? { callGateway: observeGateway } : {}),
  });
  const gatewayScope = { context, resolveGatewayContext, isWebchatConnect: () => false };
  const withCaller = <T>(run: () => Promise<T>) =>
    withGatewayToolCallerIdentity(
      {
        agentId,
        sessionKey: key,
        operationalRunInstance: { instanceId: `${id}-instance`, runId: `${id}-run` },
        receiptAuthority: () => true,
        gatewayContextResolver: resolveGatewayContext,
      },
      run,
    );
  return {
    scope,
    context,
    broadcast,
    tool,
    gatewayCalls,
    gatewayScope,
    withCaller,
    read: () => expectDefined(loadSessionEntry(scope), "status session"),
    retireGateway: () => {
      current = false;
    },
    execute: (params: { model: string; sessionKey?: string }) =>
      withPluginRuntimeGatewayRequestScope(gatewayScope, () =>
        withOperatorToolGatewayAuthority(
          { scopes: ["operator.admin"], operatorRoleActor: { kind: "system" } },
          () => withCaller(() => tool.execute("status-selection", params)),
        ),
      ),
  };
}

it.each([false, true])(
  "keeps scoped selections session-only without duplicate patch effects (placeholder=%s)",
  async (placeholder) => {
    const other = await fixture({ sessionKey: "agent:main:main" });
    const otherBefore = other.read();
    const target = await fixture({
      agentId: "support",
      sessionKey: "agent:support:main",
      entry: placeholder ? { sessionId: "" } : {},
    });
    if (placeholder) {
      expect(target.read().sessionId).toBe("");
    }
    const configWrite = vi.spyOn(configRuntime, "mutateConfigFileWithRetry");
    const configBefore = structuredClone(cfg);

    expect((await target.execute({ sessionKey: "main", model: "chosen" })).details).toMatchObject({
      agentId: "support",
      changedModel: true,
    });
    const selected = target.read();
    expect(selected.sessionId).not.toBe("");
    expect(selected).toMatchObject({ providerOverride: "fixture", modelOverride: "chosen" });
    expect(selected.modelFallback).toBeUndefined();
    expect(other.read()).toEqual(otherBefore);
    expect(onPatch).toHaveBeenCalledOnce();
    await flushPendingSessionsChangedEvents(target.context);
    target.broadcast.mockClear();

    expect((await target.execute({ sessionKey: "main", model: "chosen" })).details).toMatchObject({
      changedModel: false,
    });
    expect(target.read()).toEqual(selected);
    await flushPendingSessionsChangedEvents(target.context);
    expect(onPatch).toHaveBeenCalledOnce();
    expect(target.broadcast).not.toHaveBeenCalled();

    expect((await target.execute({ model: "default" })).details).toMatchObject({
      changedModel: true,
    });
    const reset = target.read();
    expect(reset).toMatchObject({ modelOverrideSource: "default", liveModelSwitchPending: true });
    expect(reset.providerOverride).toBeUndefined();
    expect(reset.modelOverride).toBeUndefined();
    expect(reset.modelFallback).toBeUndefined();
    expect((await target.execute({ model: "fixture/default" })).details).toMatchObject({
      changedModel: false,
    });
    expect(target.read()).toEqual(reset);
    expect(onPatch).toHaveBeenCalledTimes(2);
    expect(configWrite).not.toHaveBeenCalled();
    expect(cfg).toEqual(configBefore);
  },
);

it("recovers a rejected nickname through this session's catalog without granting cross-agent models", async () => {
  const astra = { provider: "fixture", id: "reasoner-astra", name: "Fixture Astra" };
  const other = { provider: "fixture", id: "support-only", name: "Other agent" };
  const choices = [
    ...Array.from({ length: 10 }, (_, index) => ({
      provider: "fixture",
      id: `a-choice-${index}`,
      name: `Choice ${index}`,
    })),
    astra,
  ];
  const entries = [...catalog, ...choices, other];
  cfg = modelConfig(entries, {
    model: { primary: "fixture/default" },
    models: Object.fromEntries(entries.map((entry) => [`fixture/${entry.id}`, {}])),
    modelPolicy: { allow: ["fixture/default", ...choices.map((entry) => `fixture/${entry.id}`)] },
  });
  const agents = expectDefined(cfg.agents?.entries, "model selection agents");
  agents.support = {
    models: { "fixture/support-only": { alias: "astra" } },
    modelPolicy: { allow: ["fixture/support-only"] },
  };
  expectDefined(cfg.models?.providers?.fixture, "fixture model provider").apiKey = "fixture-key";
  configRuntime.setRuntimeConfigSnapshot(cfg);
  const target = await fixture({ catalog: entries, observeGateway: true });
  const before = target.read();
  const failure = await target
    .execute({ sessionKey: "current", model: "astra" })
    .catch((error: unknown) => error);
  const catalogCall = expectDefined(
    target.gatewayCalls.find(({ request }) => request.method === "models.list"),
    "scoped model catalog call",
  );
  const discovered = await catalogCall.result;
  expect(discovered).toMatchObject({
    models: expect.arrayContaining([expect.objectContaining({ id: astra.id })]),
  });
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain("model not allowed: fixture/astra");
  expect(String(failure)).toContain("canonical model ID: fixture/reasoner-astra");
  expect(String(failure)).not.toContain("support-only");
  expect(String(failure)).toContain("Showing up to 8 choices");
  expect(target.read()).toEqual(before);

  expect((await target.execute({ model: "fixture/reasoner-astra" })).details).toMatchObject({
    changedModel: true,
    modelOverride: "fixture/reasoner-astra",
  });
  const selected = target.read();
  await expect(target.execute({ model: "fixture/support-only" })).rejects.toThrow(
    "model not allowed",
  );
  expect(target.read()).toEqual(selected);
});

it.each([
  ["unavailable", "The selected runtime is no longer available."],
  ["retired before commit", "The selected runtime is no longer available."],
  ["sandbox", "requires a sandbox"],
  ["worker", "cannot select a runtime without cloud placement support"],
])("rejects an incompatible runtime (%s) without patch effects", async (availability, message) => {
  const target = await fixture({
    entry: availability === "sandbox" ? { sandbox: "required" } : {},
  });
  const before = target.read();
  if (availability === "unavailable" || availability === "retired before commit") {
    runtime.prepare.mockResolvedValue(
      availability === "unavailable"
        ? { kind: "unavailable", message }
        : {
            kind: "ready",
            runtimeId: nativeHarness.id,
            harness: nativeHarness,
            validate: vi
              .fn<() => string | undefined>()
              .mockReturnValueOnce(undefined)
              .mockReturnValue(message),
          },
    );
  } else if (availability === "worker") {
    const placement: WorkerSessionPlacementRecord = {
      sessionId: before.sessionId,
      sessionKey: target.scope.sessionKey,
      agentId: target.scope.agentId,
      state: "active",
      executionMode: "worker-turn",
      generation: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
      stateChangedAtMs: 1,
      environmentId: "status-worker",
      activeOwnerEpoch: 1,
      workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`,
      remoteWorkspaceDir: "/workspace",
      workerBundleHash: "a".repeat(64),
      lastTranscriptAckCursor: null,
      lastLiveEventAckCursor: null,
      recoveryError: null,
      terminalReason: null,
      terminalAtMs: null,
      turnClaim: null,
    };
    target.context.workerSessionPlacementService = {
      getMany: () => new Map([[before.sessionId, placement]]),
    };
  }
  await expect(target.execute({ model: "fixture/native" })).rejects.toThrow(message);
  expect(target.read()).toEqual(before);
  expect(onPatch).not.toHaveBeenCalled();
});

it.each(["sessionId", "lifecycleRevision", "Gateway"] as const)(
  "rejects a status target whose %s retires without overwriting it",
  async (identity) => {
    const target = await fixture();
    let expected: SessionEntry | undefined = identity === "Gateway" ? target.read() : undefined;
    if (identity === "Gateway") {
      target.retireGateway();
    } else {
      const replacement = { ...target.read(), [identity]: "replacement-identity" };
      const loadCatalog = target.context.loadGatewayModelCatalogSnapshot;
      vi.spyOn(target.context, "loadGatewayModelCatalogSnapshot").mockImplementationOnce(
        async (params) => {
          await upsertSessionEntryCore(target.scope, replacement);
          expected = target.read();
          return await loadCatalog(params);
        },
      );
    }
    await expect(target.execute({ model: "chosen" })).rejects.toThrow(
      identity === "Gateway" ? "Gateway instance unavailable" : "changed before patch",
    );
    expect(target.read()).toEqual(expectDefined(expected, "persisted replacement"));
    expect(onPatch).not.toHaveBeenCalled();
  },
);

it("routes status model changes through the original operator policy and preserves unrestricted callers", async () => {
  const limited = ensureProfileForEmail("limited-model@example.test");
  const unrestricted = ensureProfileForEmail("unrestricted-model@example.test");
  setUserProfileRole(unrestricted.id, "unrestricted");
  const policyCatalog = ["blocked", "allowed"].map((id) => ({
    provider: "fixture",
    id,
    name: id,
    reasoning: false,
  }));
  cfg = modelConfig(policyCatalog, {
    model: { primary: "fixture/blocked", fallbacks: ["fixture/allowed"] },
    models: { "fixture/blocked": { alias: "blocked" }, "fixture/allowed": { alias: "chosen" } },
    modelPolicy: { allow: ["fixture/*"] },
  });
  cfg.agents = { ...cfg.agents, entries: { main: {} } };
  cfg.gateway = {
    roles: {
      default: "limited",
      definitions: {
        limited: {
          sessions: { others: "write" },
          agents: ["main"],
          scopes: ["operator.admin"],
          modelPolicy: { sourceAgent: "main", deny: ["fixture/blocked"] },
        },
        unrestricted: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin"] },
      },
    },
  };
  configRuntime.setRuntimeConfigSnapshot(cfg);
  vi.mocked(preparedCatalog.loadPublishedPreparedModelCatalog).mockResolvedValue(policyCatalog);
  // Operator policy uses real preparation; native-runtime cases inject availability failures.
  const actualRuntime = await vi.importActual<typeof import("./model-runtime-choice.js")>(
    "./model-runtime-choice.js",
  );
  runtime.prepare.mockImplementation(actualRuntime.preparePublishedModelRuntimeChoice);
  runtime.thinkingCatalog.mockImplementation(preparedCatalog.loadProviderScopedThinkingCatalog);
  const target = await fixture({
    sessionKey: "agent:main:status-model-policy",
    catalog: policyCatalog,
    sessionEntry: {
      sessionId: "model-policy-session",
      updatedAt: 1,
      visibility: "shared",
      createdActor: { type: "human", source: "profile", id: limited.id },
      providerOverride: "fixture",
      modelOverride: "blocked",
      agentRuntimeOverride: "openclaw",
    },
  });
  await withPluginRuntimeGatewayRequestScope(target.gatewayScope, async () => {
    const runAs = <T>(profileId: string, run: () => Promise<T>) => {
      const client = sharingPolicyClient({ user: profileId, scopes: ["operator.admin"] });
      return withPluginRuntimeGatewayRequestScope({ ...target.gatewayScope, client }, () =>
        withOperatorToolGatewayAuthority(
          {
            authenticatedUserProfile: expectDefined(
              client.authenticatedUserProfile,
              "operator profile",
            ),
            scopes: ["operator.admin"],
          },
          run,
        ),
      );
    };
    await target.withCaller(async () => {
      await runAs(limited.id, async () => {
        const before = target.read();
        for (const model of ["fixture/blocked", "blocked"]) {
          await expect(target.tool.execute("denied-selection", { model })).rejects.toThrow(
            "operator role cannot use this model",
          );
          expect(target.read()).toEqual(before);
        }
        expect(
          (await target.tool.execute("allowed-selection", { model: "chosen" })).details,
        ).toMatchObject({ changedModel: true });
        const selected = target.read();
        expect(selected).toMatchObject({ providerOverride: "fixture", modelOverride: "allowed" });
        expect(
          (await target.tool.execute("same-selection", { model: "chosen" })).details,
        ).toMatchObject({ changedModel: false });
        expect(target.read()).toEqual(selected);
        expect(
          (await target.tool.execute("default-selection", { model: "default" })).details,
        ).toMatchObject({ changedModel: true });
        expect(target.read().modelOverride).toBeUndefined();
        expect(target.context.getRuntimeConfig().agents?.defaults?.model).toEqual(
          cfg.agents?.defaults?.model,
        );
      });
      await runAs(unrestricted.id, async () => {
        await target.tool.execute("unrestricted-selection", { model: "fixture/blocked" });
        expect(target.read().modelOverride).toBeUndefined();
      });
    });
    await runAs(limited.id, () =>
      withPluginRuntimeGatewayRequestScope({ isWebchatConnect: () => false }, async () => {
        const before = target.read();
        await expect(target.tool.execute("missing-gateway", { model: "chosen" })).rejects.toThrow(
          "Operator model selection requires a current Gateway",
        );
        expect(target.read()).toEqual(before);
      }),
    );
  });
});
