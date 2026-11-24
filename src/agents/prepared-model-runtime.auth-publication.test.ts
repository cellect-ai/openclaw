// Install native prepared-model mocks before Gateway model consumers load.
// oxfmt-ignore
import {
  getPreparedModelRuntimeMocks,
  usePreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import "../gateway/server-methods/models.js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildModelsListResult } from "../gateway/server-methods/models-list-result.js";
import {
  createModelsListTestContext,
  requestModelsList,
} from "../gateway/server-methods/models-list-result.openai-routes.test-support.js";
import { registerGatewayModelCatalogPrivateAccess } from "../gateway/server-model-catalog-auth.js";
import {
  loadPreparedGatewayModelCatalogSnapshot,
  readPreparedGatewayModelCatalogOwnerSnapshot,
} from "../gateway/server-model-catalog.js";
import { PluginInstanceUnavailableError } from "../plugins/plugin-instance-error.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { prepareSharedAuthStoreOwnershipForNative } from "./auth-profiles/path-resolve.native.js";
import type { RuntimeAuthProfileStore } from "./auth-profiles/types.js";
import { isProfileInCooldown } from "./auth-profiles/usage-state.js";
import { getPreparedModelRuntimeAuthStore } from "./prepared-model-runtime-auth.js";
import {
  loadPublishedGatewayReplyDispatchRuntime as loadPublishedDispatch,
  prepareModelRuntimeSnapshot as prepare,
  publishPreparedModelRuntimeSnapshot as publish,
  refreshPreparedModelRuntimeSnapshots as refresh,
  registerPreparedModelRuntimePublicationListener,
  type PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.js";
import { resolvePreparedModelRuntimeOwnerBySnapshot } from "./prepared-model-runtime.owner.js";

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const { createMockSubsystemLogger } = await import("../../test/helpers/mock-subsystem-logger.js");
  return {
    ...(await importOriginal<typeof import("../logging/subsystem.js")>()),
    createSubsystemLogger: (subsystem: string) =>
      createMockSubsystemLogger(subsystem, {
        warn: (...args) => getPreparedModelRuntimeMocks().warn(...args),
      }),
  };
});

const fixture = usePreparedModelRuntimeHarness({ label: "auth-publication" });
const { mocks } = fixture;

async function publishOwner(
  agentIds = ["default"],
  registry = createEmptyPluginRegistry(),
  config: OpenClawConfig = {},
) {
  mocks.configuredAgentIds = agentIds;
  mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
  await refresh(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
  const input = fixture.agentInput("default", config);
  const snapshot = await prepare(input);
  return { config, input, snapshot, registry };
}

async function listModels(config: OpenClawConfig) {
  const context = createModelsListTestContext({ agentId: "default", cfg: config, catalog: [] });
  registerGatewayModelCatalogPrivateAccess(context.loadGatewayModelCatalogSnapshot, {
    loadDeferred: (params) =>
      loadPreparedGatewayModelCatalogSnapshot({ ...params, getConfig: () => config }),
    readPrepared: (params) =>
      readPreparedGatewayModelCatalogOwnerSnapshot({ ...params, getConfig: () => config }),
  });
  context.readPreparedModelsList = (request) =>
    buildModelsListResult({ source: { kind: "gateway", context }, ...request });
  const response = await requestModelsList(context, {
    agentId: "default",
    view: "all",
    includeDefaultModels: false,
  });
  expect(response.mock.calls[0]?.[0]).toBe(true);
}

it.for([false, true])(
  "joins a publication superseding the fresh auth retry (fails: %s)",
  async (fails, { signal }) => {
    const { snapshot, config } = await publishOwner();
    const owner = resolvePreparedModelRuntimeOwnerBySnapshot(snapshot)!;
    const retryStarted = createDeferred();
    const releaseRetry = createDeferred();
    const successorStarted = createDeferred();
    const releaseSuccessor = createDeferred();
    const failure = new Error("successor credential acquisition failed");
    mocks.resolveAmbientCredentials
      .mockClear()
      .mockImplementationOnce(() => {
        throw new PluginInstanceUnavailableError("synthetic retired generation");
      })
      .mockImplementationOnce(async () => {
        retryStarted.resolve();
        await releaseRetry.promise;
        return {};
      })
      .mockImplementationOnce(async () => {
        successorStarted.resolve();
        await releaseSuccessor.promise;
        if (fails) {
          throw failure;
        }
        return {};
      });
    mocks.mutationListener?.({ agentDir: owner.input.agentDir, affectsInheritedStores: false });
    const reader = prepare(owner.input);
    const dispatch = loadPublishedDispatch({ agentId: "default" });
    void reader.catch(() => {});
    void dispatch.catch(() => {});
    let successor: ReturnType<typeof publish> | undefined;
    try {
      await withinTest(retryStarted.promise, signal);
      successor = publish(owner.input, {
        force: true,
        provenance: "configured",
        catalogMode: "static",
      });
      void successor.catch(() => {});
      releaseRetry.resolve();
      await withinTest(successorStarted.promise, signal);
      releaseSuccessor.resolve();
      if (fails) {
        await expect(successor).rejects.toBe(failure);
        await expect(reader).rejects.toThrow(failure.message);
        await expect(dispatch).rejects.toThrow(failure.message);
      } else {
        const latest = await successor;
        await expect(reader).resolves.toBe(latest);
        await expect(dispatch).resolves.toMatchObject({ agentId: "default", config });
        expect(latest.isCurrent()).toBe(true);
        await listModels(config);
        expect(mocks.warn).not.toHaveBeenCalled();
      }
      expect(mocks.resolveAmbientCredentials).toHaveBeenCalledTimes(3);
    } finally {
      releaseRetry.resolve();
      releaseSuccessor.resolve();
      await Promise.allSettled([reader, dispatch, successor]);
    }
  },
);

describe("prepared model auth publication", () => {
  it("retains the prepared generation through 100 concurrent availability publications", async () => {
    const snapshots = await vi.importActual<typeof import("./auth-profiles/runtime-snapshots.js")>(
      "./auth-profiles/runtime-snapshots.js",
    );
    const agentDir = fixture.state.agentDir("usage-publication");
    const input = { config: {}, agentDir };
    const store: RuntimeAuthProfileStore = {
      version: 1,
      profiles: { "test:primary": { type: "token", provider: "test", token: "synthetic-token" } },
    };
    prepareSharedAuthStoreOwnershipForNative(fixture.state.env);
    snapshots.setRuntimeAuthProfileStoreSnapshot(store, agentDir);
    mocks.preparedAuthStore = store;
    const initial = await publish(input);
    const events = vi.fn();
    const unregisterEvents = registerPreparedModelRuntimePublicationListener(events);
    const unregisterAuth = snapshots.registerRuntimeAuthProfileStoreMutationListener((event) => {
      mocks.mutationListener?.(event);
    });
    try {
      const owner = resolvePreparedModelRuntimeOwnerBySnapshot(initial)!;
      const generation = owner.pluginGeneration;
      const publications: Promise<PreparedModelRuntimeSnapshot>[] = [];
      const preparations = mocks.loadAgentRuntimePluginRegistryHandle.mock.calls.length;
      for (let index = 0; index < 100; index += 1) {
        snapshots.updateRuntimeAuthProfileStoreSnapshot(
          {
            ...store,
            usageStats: {
              "test:primary": index % 2 === 0 ? { cooldownUntil: Date.now() + 60_000 } : {},
            },
          },
          agentDir,
        );
        expect(
          isProfileInCooldown(getPreparedModelRuntimeAuthStore(initial)!, "test:primary"),
        ).toBe(index % 2 === 0);
        publications.push(publish(input));
        await Promise.resolve();
      }
      expect((await Promise.all(publications)).every((snapshot) => snapshot === initial)).toBe(
        true,
      );
      expect(owner.pluginGeneration).toBe(generation);
      expect(initial.isCurrent()).toBe(true);
      expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(preparations);
      expect(events).not.toHaveBeenCalled();
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(1);

      const credentialChanges: RuntimeAuthProfileStore["profiles"][] = [
        {
          "test:primary": {
            type: "token" as const,
            provider: "test",
            token: "changed-synthetic-token",
          },
        },
        {
          ...store.profiles,
          "test:secondary": {
            type: "token" as const,
            provider: "test",
            token: "second-synthetic-token",
          },
        },
      ];
      for (const profiles of credentialChanges) {
        const previous = await prepare(input);
        const changedStore = { ...store, profiles };
        mocks.preparedAuthStore = changedStore;
        snapshots.updateRuntimeAuthProfileStoreSnapshot(changedStore, agentDir);
        expect(previous.isCurrent()).toBe(false);
        const replacement = await prepare(input);
        expect(replacement).not.toBe(previous);
        expect(getPreparedModelRuntimeAuthStore(replacement)?.profiles).toEqual(profiles);
        expect(events).toHaveBeenCalledWith({ phase: "invalidated" });
      }
    } finally {
      unregisterAuth();
      unregisterEvents();
      snapshots.clearRuntimeAuthProfileStoreSnapshotCore(agentDir);
    }
  });
});
