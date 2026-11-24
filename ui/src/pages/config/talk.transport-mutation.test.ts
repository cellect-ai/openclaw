/* @vitest-environment jsdom */

import type { TalkCatalogResult } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { NativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import type { SelectPicker } from "../../components/select-picker.ts";
import { t } from "../../i18n/index.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { createApplicationGateway } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  expectVoiceState,
  mountTalkPage,
  waitForTalkCatalog,
  readVoiceOptions,
  setTalkRealtimeConfig,
} from "./talk.test-support.tsx";

const ACTIVE_VOICES = ["", "cove", "spruce", "custom-voice"];
const DEFAULT_VOICES = ["", "marin", "custom-voice"];

const modelPicker = (page: HTMLElement) =>
  page.querySelector<SelectPicker>("openclaw-select-picker");
const waitCatalogCalls = (request: unknown, count: number) =>
  waitForSolid(() => expect(request).toHaveBeenCalledTimes(count));
const realtimePath = (field: string) => ["talk", "realtime", field];

type TalkMutationHarnessOptions = {
  configSaving?: boolean;
  speakerVoice?: string | null;
  providerOption?: Partial<TalkCatalogResult["realtime"]["providers"][number]>;
  nativeDeviceSettings?: NativeDeviceSettingsCapability;
  voiceWakeRequest?: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<{ triggers: string[] }>;
  catalogRequest?: (
    requestIndex: number,
    catalog: TalkCatalogResult,
  ) => Promise<TalkCatalogResult> | TalkCatalogResult;
  configSnapshot?: { hash?: string | null; configRevisionHash?: string | null };
  activeProvider?: string | null;
  activeVoiceSelectionPolicy?: "allowlist-default";
  aliases?: string[];
  consultRouting?: string | null;
  defaultModel?: string;
  model?: string | null;
  openAIProviderModel?: string;
  provider?: string | null;
  transport?: string | null;
  transports?: TalkCatalogResult["transports"];
  voicesByModel?: Record<string, string[]>;
};

function createTalkMutationHarness(options: TalkMutationHarnessOptions = {}) {
  const catalog = {
    modes: ["realtime"],
    transports: ["gateway-relay", "webrtc"],
    brains: ["agent-consult"],
    speech: { providers: [] },
    transcription: { providers: [] },
    realtime: {
      ready: true,
      activeProvider: options.activeProvider ?? "openai",
      providers: [
        {
          id: "openai",
          label: "OpenAI",
          configured: true,
          aliases: options.aliases ?? [],
          models: [options.defaultModel ?? "gpt-live-test-canary"],
          voices: ["marin"],
          activeVoices: ["cove", "spruce"],
          activeVoiceSelectionPolicy: options.activeVoiceSelectionPolicy,
          voicesByModel: options.voicesByModel,
          modelFamilySettings: {
            family: "gpt-live",
            unlistedModelVoices: "active",
            unsupportedTransports: ["provider-websocket"],
            gatewayRelayHandlesAgentConsult: true,
            hint: {
              titleKey: "talkPage.gptLive.title",
              descriptionKey: "talkPage.gptLive.hint",
              readyKey: "talkPage.gptLive.ready",
            },
          },
          transports: options.transports ?? ["gateway-relay"],
          defaultModel: options.defaultModel ?? "gpt-live-test-canary",
          ...options.providerOption,
        },
        {
          id: "xai",
          label: "xAI",
          configured: true,
          aliases: [],
          models: ["grok-voice"],
          voices: ["ara"],
          activeVoices: ["xai-active"],
          transports: ["gateway-relay"],
          defaultModel: "grok-voice",
        },
        {
          id: "litellm",
          label: "LiteLLM Realtime",
          configured: true,
          aliases: ["litellm-realtime"],
          models: ["grok-voice-think-fast-2.0", "gemini-3.8-live"],
          voices: [],
          voicesByModel: { "grok-voice-think-fast-2.0": ["eve", "ara", "rex", "sal", "leo"] },
          transports: ["gateway-relay"],
          defaultModel: "grok-voice-think-fast-2.0",
        },
      ],
    },
  } satisfies TalkCatalogResult;
  let catalogRequestIndex = 0;
  const request = vi.fn(
    async (_method: string, _params: Record<string, unknown>, _requestOptions?: unknown) => {
      catalogRequestIndex += 1;
      return await (options.catalogRequest?.(catalogRequestIndex, catalog) ?? catalog);
    },
  );
  const { gateway, publish } = createApplicationGateway();
  gateway.connection.gatewayUrl = "wss://gateway.example.test";
  const hello: ApplicationContext["gateway"]["snapshot"]["hello"] = options.voiceWakeRequest
    ? {
        type: "hello-ok" as const,
        protocol: 4,
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: ["voicewake.get", "voicewake.set"] },
      }
    : null;
  publish({
    ...gateway.snapshot,
    client: {
      request: (method: string, params: Record<string, unknown>, requestOptions?: unknown) =>
        method.startsWith("voicewake.")
          ? (options.voiceWakeRequest?.(method, params) ?? Promise.resolve({ triggers: [] }))
          : request(method, params, requestOptions),
    } as unknown as GatewayBrowserClient,
    phase: "connected",
    hello,
    assistantAgentId: "main",
    sessionKey: "main",
  });
  const configForm = {
    talk: {
      realtime: {
        provider: options.provider === undefined ? "openai" : options.provider,
        ...(options.model === null
          ? {}
          : { model: options.model === undefined ? "gpt-realtime-2.1" : options.model }),
        transport: options.transport === undefined ? "gateway-relay" : options.transport,
        consultRouting: options.consultRouting,
        speakerVoice: options.speakerVoice,
        providers: options.openAIProviderModel
          ? { openai: { model: options.openAIProviderModel } }
          : undefined,
      },
    },
  };
  const runtimeConfigListeners = new Set<() => void>();
  const runtimeConfig = {
    state: {
      configForm,
      configSnapshot: options.configSnapshot ?? { hash: "hash" },
      configLoading: false,
      configSaving: options.configSaving ?? false,
      configApplying: false,
    },
    patchForm: vi.fn(),
    removeFormValue: vi.fn(),
    subscribe: (listener: () => void) => {
      runtimeConfigListeners.add(listener);
      return () => runtimeConfigListeners.delete(listener);
    },
  };
  const context = {
    nativeDeviceSettings: options.nativeDeviceSettings ?? null,
    gateway,
    runtimeConfig,
  } as unknown as ApplicationContext;
  const page = mountTalkPage(context, configForm);
  return {
    page,
    request,
    runtimeConfig,
    configForm,
    updateGateway: (patch: Partial<ApplicationContext["gateway"]["snapshot"]>) => {
      publish({ ...gateway.snapshot, ...patch });
    },
    setConfigHash: (hash: string | null) => {
      runtimeConfig.state.configSnapshot.hash = hash;
      runtimeConfigListeners.forEach((notify) => notify());
    },
    setGatewayConnection: (connected: boolean, gatewayUrl = gateway.connection.gatewayUrl) => {
      gateway.connection.gatewayUrl = gatewayUrl;
      publish({
        ...gateway.snapshot,
        phase: connected ? "connected" : "reconnecting",
        hello: connected ? hello : null,
      });
    },
  };
}

async function selectMutation(
  field: "model" | "provider",
  value: string,
  options: TalkMutationHarnessOptions = {},
) {
  const harness = createTalkMutationHarness(options);
  await waitForSolid(() =>
    expect(
      field === "model"
        ? modelPicker(harness.page)
        : harness.page.querySelector('input[type="radio"]'),
    ).not.toBeNull(),
  );
  if (field === "model") {
    harness.page.changeModel(value);
  } else {
    harness.page.changeProvider(value);
  }
  expect(harness.runtimeConfig.patchForm).toHaveBeenCalledWith(realtimePath(field), value);
  return harness.runtimeConfig.removeFormValue;
}

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("TalkSettingsPage realtime transport mutation", () => {
  async function resetHarness(options: TalkMutationHarnessOptions = {}) {
    const harness = createTalkMutationHarness({
      defaultModel: "gpt-realtime-2.1",
      model: null,
      ...options,
    });
    await waitForTalkCatalog(harness.page, harness.request);
    return harness;
  }
  it("keeps same-Gateway provider and model-specific voice choices visible through reconnect and refresh failure", async () => {
    const harness = createTalkMutationHarness();
    const { page, request, configForm, updateGateway } = harness;
    await waitForTalkCatalog(page, request);

    const litellmForm = {
      ...configForm,
      talk: {
        ...configForm.talk,
        realtime: {
          ...configForm.talk.realtime,
          provider: "litellm",
          model: "grok-voice-think-fast-2.0",
        },
      },
    };
    page.context.runtimeConfig.state.configForm = litellmForm;
    page.configObject = litellmForm;
    flush();

    expect(page.querySelector('input[type="radio"]')).not.toBeNull();
    expect(
      [...page.querySelectorAll<HTMLOptionElement>("select option")].map((option) => option.value),
    ).toEqual(["", "eve", "ara", "rex", "sal", "leo"]);

    updateGateway({ phase: "reconnecting" });
    flush();
    // The catalog view is an async memo; the stale snapshot renders once it settles.
    await waitForSolid(() => expect(page.textContent).toContain(t("talkPage.status.staleHint")));
    expect(page.querySelector<HTMLInputElement>('input[type="radio"]')?.disabled).toBe(true);
    expect(page.querySelector("select")?.disabled).toBe(true);

    request.mockRejectedValueOnce(new Error("temporary gateway refresh failure"));
    (page.context.gateway as { connectionRevision: number }).connectionRevision += 1;
    updateGateway({ phase: "connected" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    flush();
    expect(page.querySelector('input[type="radio"]')).not.toBeNull();
    expect(page.querySelector("select")?.disabled).toBe(true);

    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(page.textContent).not.toContain(t("talkPage.status.staleHint")));
    expect(page.querySelector("select")?.disabled).toBe(false);
  });

  it.each([
    ["allowlist-default", true],
    [undefined, false],
  ] as const)(
    "marks absent saved voices unsupported only for authoritative catalogs: %s",
    async (activeVoiceSelectionPolicy, expectedWarning) => {
      const { page, request } = createTalkMutationHarness({
        activeVoiceSelectionPolicy,
        model: null,
      });
      await waitForTalkCatalog(page, request);
      setTalkRealtimeConfig(page, { provider: "openai", speakerVoice: "custom-voice" });
      flush();

      const savedOption = page.querySelector<HTMLOptionElement>('option[value="custom-voice"]');
      const text = page.textContent ?? "";
      expect(savedOption?.textContent?.includes(t("talkPage.voice.unsupported"))).toBe(
        expectedWarning,
      );
      expect(text.includes(t("talkPage.voice.unsupportedDefault"))).toBe(expectedWarning);
    },
  );

  it("acknowledges a model reset from the canonical config revision", async () => {
    const hashCatalog = createDeferred();
    const { page, request, runtimeConfig, setConfigHash } = await resetHarness({
      activeVoiceSelectionPolicy: "allowlist-default",
      configSnapshot: { hash: null, configRevisionHash: "revision-1" },
      catalogRequest: (requestIndex, catalog) =>
        requestIndex === 3 ? hashCatalog.promise.then(() => catalog) : catalog,
    });
    setTalkRealtimeConfig(page, { provider: "openai", speakerVoice: "custom-voice" });
    await waitForSolid(() => expectVoiceState(page, ACTIVE_VOICES, true));

    setTalkRealtimeConfig(page, {
      provider: "openai",
      model: "gpt-realtime-2.1",
      speakerVoice: "custom-voice",
    });
    await waitForSolid(() => expectVoiceState(page, DEFAULT_VOICES, false));

    page.changeModel(null);
    setTalkRealtimeConfig(page, { provider: "openai", speakerVoice: "custom-voice" });
    await waitForSolid(() => expectVoiceState(page, DEFAULT_VOICES, false));

    window.dispatchEvent(new Event("focus"));
    await waitCatalogCalls(request, 2);
    await waitForSolid(() => expectVoiceState(page, DEFAULT_VOICES, false));

    Object.assign(runtimeConfig.state.configSnapshot, { configRevisionHash: "revision-2" });
    setConfigHash(null);
    await waitCatalogCalls(request, 3);
    window.dispatchEvent(new Event("focus"));
    await waitCatalogCalls(request, 4);
    await waitForSolid(() => expectVoiceState(page, ACTIVE_VOICES, true));
    hashCatalog.resolve();
    await request.mock.results[2]?.value;
    expectVoiceState(page, ACTIVE_VOICES, true);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("retains a reset without revisions, then clears it after reconnect with a revision", async () => {
    const { page, request, setConfigHash, setGatewayConnection } = await resetHarness({
      activeVoiceSelectionPolicy: "allowlist-default",
      configSnapshot: { hash: null, configRevisionHash: null },
    });
    page.changeModel(null);
    setTalkRealtimeConfig(page, { provider: "openai", speakerVoice: "custom-voice" });
    flush();

    window.dispatchEvent(new Event("focus"));
    await waitCatalogCalls(request, 2);
    expectVoiceState(page, DEFAULT_VOICES, false);
    await waitForSolid(() => expectVoiceState(page, DEFAULT_VOICES, false));

    setGatewayConnection(false);
    setConfigHash("hash-3");
    expectVoiceState(page, DEFAULT_VOICES, false);
    setGatewayConnection(true);
    await waitCatalogCalls(request, 3);
    await waitForSolid(() => expectVoiceState(page, ACTIVE_VOICES, true));
  });

  it("clears model reset intent on explicit model, provider, and Gateway changes", async () => {
    const { page, request, setGatewayConnection } = await resetHarness({
      voicesByModel: {
        "gpt-realtime-2.1": ["marin"],
        "gpt-realtime-alt": ["verse"],
      },
    });

    page.changeModel(null);
    page.changeModel("gpt-realtime-alt");
    setTalkRealtimeConfig(page, { provider: "openai", model: "gpt-realtime-alt" });
    flush();
    expect(readVoiceOptions(page)).toEqual(["", "verse"]);

    page.changeModel(null);
    page.changeProvider("xai");
    setTalkRealtimeConfig(page, { provider: "xai" });
    flush();
    expect(readVoiceOptions(page)).toEqual(["", "xai-active"]);

    page.changeModel(null);
    flush();
    expect(readVoiceOptions(page)).toEqual(["", "ara"]);
    setGatewayConnection(true, "wss://replacement.example.test");
    await waitCatalogCalls(request, 2);
    await waitForSolid(() => expect(readVoiceOptions(page)).toEqual(["", "xai-active"]));
  });

  const rejectedModelOptions: TalkMutationHarnessOptions = {
    model: "gpt-realtime-2.1",
    consultRouting: "force-agent-consult",
    aliases: ["openai-voice"],
    provider: "openai-voice",
  };
  it.each([
    [
      "relay consult",
      { consultRouting: " Force-Agent-Consult ", transports: ["gateway-relay"] },
      "consultRouting",
    ],
    [
      "another provider",
      { provider: "xai", transport: "provider-websocket", consultRouting: "force-agent-consult" },
      null,
    ],
    [
      "auto provider",
      { activeProvider: "openai", provider: null, transports: ["gateway-relay"] },
      null,
    ],
    [
      "family rejection",
      {
        ...rejectedModelOptions,
        transport: "provider-websocket",
        transports: ["provider-websocket", "gateway-relay"],
      },
      "transport",
      " GPT-LIVE-test-canary ",
    ],
    [
      "provider rejection",
      { ...rejectedModelOptions, transport: "gateway-relay", transports: ["webrtc"] },
      "transport",
      " GPT-LIVE-test-canary ",
    ],
  ] satisfies [string, TalkMutationHarnessOptions, string | null, string?][])(
    "applies model transport policy: %s",
    async (_name, options, removed, model = "gpt-live-test-canary") => {
      const remove = await selectMutation("model", model, options);
      if (removed) {
        expect(remove).toHaveBeenCalledExactlyOnceWith(realtimePath(removed));
      } else {
        expect(remove).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    [
      "no family facts",
      {
        transport: "provider-websocket",
        transports: ["provider-websocket", "gateway-relay"],
        providerOption: { modelFamilySettings: undefined },
      },
      null,
      ["transport", "consultRouting"],
    ],
    [
      "GPT-Live fallback",
      {
        consultRouting: "force-agent-consult",
        defaultModel: "gpt-realtime-2.1",
        openAIProviderModel: "gpt-live-test-canary",
        transports: ["gateway-relay", "webrtc"],
      },
      "consultRouting",
      ["transport"],
    ],
    ["positive rejection", { transports: ["webrtc"] }, "transport", []],
  ] satisfies [string, TalkMutationHarnessOptions, string | null, string[]][])(
    "applies provider transport policy: %s",
    async (_name, options, removed, retained) => {
      const remove = await selectMutation("provider", "openai", { provider: "xai", ...options });
      if (removed) {
        expect(remove).toHaveBeenCalledWith(realtimePath(removed));
      }
      for (const field of retained) {
        expect(remove).not.toHaveBeenCalledWith(realtimePath(field));
      }
    },
  );
});
