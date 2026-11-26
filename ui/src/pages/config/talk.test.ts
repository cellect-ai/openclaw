import type { TalkCatalogResult } from "@openclaw/gateway-protocol";
/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { TalkSchema } from "../../../../src/config/zod-schema.root-support.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import {
  CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS,
  createConfigCapabilityHarness,
} from "../../lib/config/config-test-harness.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import {
  createIosNativeDeviceSettingsSnapshot,
  createNativeDeviceSettingsSnapshot,
} from "../../test-helpers/native-device-settings.ts";
import { choosePickerValue, updatePickers } from "../../test-helpers/select-picker.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  editTrigger,
  tick,
  triggerInput,
  triggerAlert,
  retryTrigger,
  expectTriggerWrite,
  expectFocused,
} from "./talk-voicewake.test-support.ts";
import {
  createTalkMutationHarness,
  mountTalkPage,
  waitForTalkCatalog,
  mountTalkSettingsRoutes,
  nativeVoice,
  readVoiceOptions,
  realtimeModelPicker,
  type TalkMutationHarnessOptions,
} from "./talk.test-support.tsx";

const modelPicker = realtimeModelPicker;
const waitCatalogCalls = (request: unknown, count: number) =>
  waitForSolid(() => expect(request).toHaveBeenCalledTimes(count));
const realtimePath = (field: string) => ["talk", "realtime", field];
const settingRows = (page: HTMLElement) => [...page.querySelectorAll<HTMLElement>(".settings-row")];
const rowTitle = (row: HTMLElement) =>
  row.querySelector(".settings-row__title")?.textContent?.trim();

type TriggerReply = { triggers: string[] };
async function voiceWakeFixture(
  write: (index: number) => TriggerReply | Promise<TriggerReply>,
  read: () => string[] = () => ["openclaw"],
) {
  let writes = 0;
  const voiceWakeRequest = vi.fn(async (method: string) =>
    method === "voicewake.get" ? { triggers: read() } : write(++writes),
  );
  const harness = createTalkMutationHarness({ voiceWakeRequest });
  await waitForSolid(() => expect(triggerInput(harness.page)?.value).toBe("openclaw"));
  vi.useFakeTimers();
  return {
    ...harness,
    input: triggerInput(harness.page),
    voiceWakeRequest,
    writes: () => writes,
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

async function readyTalk(options: TalkMutationHarnessOptions = {}) {
  const harness = createTalkMutationHarness(options);
  await waitForSolid(() => expect(modelPicker(harness.page)).not.toBeNull());
  await updatePickers(harness.page);
  return harness;
}
describe("Talk provider autosave", () => {
  it.each([false, true])(
    "saves the selected credential-profile provider without replacing existing entries (existing: %s)",
    async (existing) => {
      const harness = createTalkMutationHarness();
      harness.page.remove();
      const initial = {
        talk: {
          realtime: {
            provider: "litellm",
            model: "gemini-3.8-live",
            transport: "gateway-relay",
            providers: {
              litellm: { baseUrl: "https://proxy.example.test", model: "gemini-3.8-live" },
              ...(existing ? { xai: { speakerVoice: "ara", model: "grok-voice" } } : {}),
            },
          },
        },
      };
      let stored = initial;
      const submissions: unknown[] = [];
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "talk.catalog") {
          return harness.request(method, {});
        }
        if (method === "config.get") {
          return {
            config: stored,
            raw: JSON.stringify(stored),
            hash: "test-hash",
            valid: true,
            issues: [],
          };
        }
        if (method === "config.set") {
          const submitted = JSON.parse((params as { raw: string }).raw) as typeof initial;
          submissions.push(submitted);
          TalkSchema.parse(submitted.talk);
          stored = submitted;
          return { config: stored, hash: "saved-hash" };
        }
        return {};
      });
      const { runtimeConfig } = createConfigCapabilityHarness(
        request as GatewayBrowserClient["request"],
      );
      try {
        await runtimeConfig.ensureLoaded();
        harness.page = mountTalkPage(
          { ...harness.page.context, runtimeConfig },
          runtimeConfig.state.configForm ?? {},
        );
        flush();
        await vi.waitFor(() => expect(harness.page.querySelector('[value="xai"]')).not.toBeNull());
        vi.useFakeTimers();
        harness.page.changeProvider("xai");
        await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
        expect(submissions).toHaveLength(1);
        expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
        expect(stored.talk.realtime).toEqual({
          provider: "xai",
          transport: "gateway-relay",
          providers: {
            litellm: initial.talk.realtime.providers.litellm,
            xai: existing ? { speakerVoice: "ara", model: "grok-voice" } : {},
          },
        });
        harness.page.configObject = runtimeConfig.state.configForm ?? {};
        flush();
        const auto = harness.page.querySelector<HTMLElement>('[value=""]');
        expect(auto?.hasAttribute("disabled")).toBe(true);
        auto?.click();
        harness.page.changeProvider(null);
        await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
        expect(submissions).toHaveLength(1);
        expect(runtimeConfig.state.configForm).toEqual(stored);
      } finally {
        harness.page.remove();
        runtimeConfig.dispose();
      }
    },
  );
});

describe("Talk speaker voice previews", () => {
  it("previews the newly selected draft voice and shows provider failures without breaking the picker", async () => {
    vi.stubGlobal(
      "AudioContext",
      class {
        resume = async () => {};
        close = async () => {};
      },
    );
    const harness = createTalkMutationHarness({
      voicesByModel: { "gpt-realtime-2.1": ["marin", "spruce"] },
    });
    await waitForTalkCatalog(harness.page, harness.request);
    harness.runtimeConfig.patchForm.mockImplementation((_path: unknown, value: unknown) => {
      Object.assign(harness.runtimeConfig.state.configForm.talk.realtime, { speakerVoice: value });
    });
    harness.request.mockImplementation(async (method) => {
      throw new Error(`${method} unavailable`);
    });
    await vi.waitFor(() =>
      expect(harness.page.querySelector('select[aria-label="Speaker voice"]')).not.toBeNull(),
    );
    const voice = harness.page.querySelector<HTMLSelectElement>(
      'select[aria-label="Speaker voice"]',
    );
    expect(voice).not.toBeNull();
    voice!.value = "spruce";
    voice!.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith(
        "talk.voice.preview",
        { provider: "openai", model: "gpt-realtime-2.1", voice: "spruce" },
        { timeoutMs: 25_000 },
      ),
    );
    await vi.waitFor(() =>
      expect(harness.page.textContent).toContain(t("talkPage.voice.previewError")),
    );
    expect(harness.page.querySelector('select[aria-label="Speaker voice"]')).not.toBeNull();
  });
});

it("locks every curated picker while config is saving", async () => {
  const { page } = await readyTalk({ configSaving: true, speakerVoice: "marin" });
  expect(page.querySelector(".settings-segmented__input")?.hasAttribute("disabled")).toBe(true);
  expect([...page.querySelectorAll("select")]).toMatchObject([{ disabled: true }]);
  expect(modelPicker(page)?.querySelector("button")?.disabled).toBe(true);
});

it("commits provider-local model ids without qualifying them", async () => {
  const { page, runtimeConfig } = await readyTalk({
    providerOption: { models: ["gpt-live", "gpt-realtime"] },
  });
  await choosePickerValue(modelPicker(page)!, "gpt-realtime");
  expect(runtimeConfig.patchForm).toHaveBeenCalledWith(realtimePath("model"), "gpt-realtime");
});

it.each([
  ["gpt-live", true],
  [" GPT-LIVE-test-canary ", true],
  ["gpt-liveish", false],
] as const)("renders the GPT-Live hint only for the exact family: %s", async (model, showsHint) => {
  const { page } = await readyTalk({ model });
  expect(page.textContent?.includes(t("talkPage.gptLive.hint"))).toBe(showsHint);
  if (showsHint) {
    const row = settingRows(page).find((entry) =>
      entry.textContent?.includes("Released browser/Gateway-owned WebRTC"),
    );
    expect(row?.textContent).toContain("GPT-Live");
    expect(row?.textContent).toContain("Ready");
    expect(row?.textContent).not.toContain("talkPage.");
  }
});

it.each([
  ["model", "gpt-live-1-codex", "spruce", ["arbor", "spruce"]],
  ["provider", "gpt-live-private-example", null, ["other-voice"]],
] satisfies [string, string, string | null, string[]][])(
  "resolves the %s voice catalog",
  async (kind, model, speakerVoice, voices) => {
    const { page } = await readyTalk({
      model,
      speakerVoice,
      provider: kind === "model" ? "openai" : "other",
      providerOption:
        kind === "model"
          ? { voicesByModel: { [model]: voices } }
          : { id: "other", voices, activeVoices: ["active-only"], modelFamilySettings: undefined },
    });
    expect(readVoiceOptions(page)).toEqual(["", ...voices]);
    expect(
      [...page.querySelectorAll<HTMLOptionElement>("select option")].map((option) => option.value),
    ).toEqual(["", ...voices]);
    if (kind === "provider") {
      expect(page.textContent).not.toContain(t("talkPage.gptLive.hint"));
    }
  },
);

describe("Talk catalog boundaries", () => {
  it("keeps the trigger editor mounted through catalog failure and focus recovery", async () => {
    const initial = createDeferred<TalkCatalogResult>();
    const refresh = createDeferred();
    const { page, request } = createTalkMutationHarness({
      voiceWakeRequest: async () => ({ triggers: ["openclaw"] }),
      catalogRequest: (index, catalog) =>
        index === 1 ? initial.promise : index === 2 ? catalog : refresh.promise.then(() => catalog),
    });
    await waitForSolid(() => expect(triggerInput(page)?.value).toBe("openclaw"));
    const input = triggerInput(page);
    initial.reject(new Error("catalog temporarily unavailable"));
    await waitForSolid(() => expect(page.textContent).toContain(t("talkPage.status.unavailable")));
    expect(page.textContent).toContain("catalog temporarily unavailable");
    expect(page.textContent).not.toContain(t("talkPage.status.unavailableHint"));
    expect(page.textContent).toContain("gpt-realtime-2.1");
    expect(triggerInput(page)).toBe(input);

    window.dispatchEvent(new Event("focus"));
    await waitForSolid(() => expect(modelPicker(page)).not.toBeNull());
    expect(triggerInput(page)).toBe(input);
    expect(request).toHaveBeenCalledTimes(2);

    const picker = modelPicker(page);
    window.dispatchEvent(new Event("focus"));
    await waitCatalogCalls(request, 3);
    expect(modelPicker(page)).toBe(picker);
    expect(triggerInput(page)).toBe(input);
    expect(page.textContent).not.toContain(t("common.loading"));
    refresh.resolve();
    await request.mock.results[2]?.value;
  });

  it("keeps a retired connection's catalog out of provider display and mutation policy", async () => {
    const old = createDeferred();
    const current = createDeferred();
    const { page, request, runtimeConfig, setGatewayConnection } = createTalkMutationHarness({
      defaultModel: "realtime-model",
      transport: "provider-websocket",
      catalogRequest: (index, catalog) =>
        (index === 1 ? old.promise : current.promise).then<TalkCatalogResult>(() => ({
          ...catalog,
          realtime: {
            ...catalog.realtime,
            providers: catalog.realtime.providers.map((provider) =>
              provider.id === "openai"
                ? {
                    ...provider,
                    label: index === 1 ? "Old provider" : "Current provider",
                    transports: index === 1 ? ["webrtc"] : ["provider-websocket"],
                  }
                : provider,
            ),
          },
        })),
    });
    await waitCatalogCalls(request, 1);
    setGatewayConnection(true, "wss://replacement.example.test");
    await waitCatalogCalls(request, 2);
    current.resolve();
    await waitForSolid(() => expect(page.textContent).toContain("Current provider"));
    old.resolve();
    await request.mock.results[0]?.value;
    flush();
    expect(page.textContent).not.toContain("Old provider");
    page.changeProvider("openai");
    expect(runtimeConfig.removeFormValue).not.toHaveBeenCalledWith(realtimePath("transport"));
  });
});

describe("Talk device and voice wake settings", () => {
  it("renders only published iOS voice controls and routes edits to native owners", async () => {
    const snapshot = createIosNativeDeviceSettingsSnapshot();
    snapshot.voice = { supported: true, wakeEnabled: false };
    const nativeDeviceSettings = nativeVoice(snapshot).settings;
    const { page, request } = createTalkMutationHarness({ nativeDeviceSettings });
    await waitForSolid(() => expect(request).toHaveBeenCalled());
    flush();
    const section = [...page.querySelectorAll<HTMLElement>(".settings-section")].find(
      (element) =>
        element.querySelector(".settings-section__heading")?.textContent?.trim() === "This iPhone",
    )!;
    expect(section).toBeDefined();
    const rows = settingRows(section);
    expect(rows.map(rowTitle)).toEqual(["Voice wake"]);
    const next = !rows[0]!.querySelector<HTMLInputElement>(".settings-toggle__input")!.checked;
    rows[0]!.click();
    expect(nativeDeviceSettings.set).toHaveBeenCalledExactlyOnceWith(
      "voice.wakeEnabled",
      next,
      expect.any(Function),
    );
    expect(section.querySelector("select, button")).toBeNull();
  });

  it.each(["retry", "replacement"])("isolates trigger reads on %s", async (mode) => {
    const pending = createDeferred<{ triggers: string[] }>();
    const request = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ triggers: ["new trigger"] });
    const { page, setGatewayConnection } = createTalkMutationHarness({ voiceWakeRequest: request });
    await waitForSolid(() => expect(page.querySelector(".model-picker")).not.toBeNull());
    expect(triggerInput(page)).toMatchObject({ rows: 4, value: "", disabled: true });
    expect(triggerInput(page).getAttribute("aria-busy")).toBe("true");
    if (mode === "retry") {
      pending.reject(new TypeError("Cannot read properties of undefined"));
      await waitForSolid(() =>
        expect(triggerAlert(page)?.textContent).toBe(
          `${t("configPage.deviceTalk.triggerWordsLoadFailed")}${t("common.retry")}`,
        ),
      );
      expect(page.querySelector(".settings-group [role='alert']")).toBeNull();
      retryTrigger(page);
    } else {
      setGatewayConnection(false);
      setGatewayConnection(true, "wss://replacement-gateway.example.test");
      pending.reject(new Error("retired Gateway read"));
    }
    await waitForSolid(() => expect(triggerInput(page)?.value).toBe("new trigger"));
    expect(triggerInput(page).disabled).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
    expect(triggerAlert(page)).toBeNull();
  });

  it("redacts the Gateway's reason when trigger words fail to load", async () => {
    const voiceWakeRequest = vi.fn(async () => {
      throw new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "Access denied. Authorization: Basic dXNlcjpzdXBlcnNlY3JldHBhc3N3b3Jk",
      });
    });
    const { page } = createTalkMutationHarness({ voiceWakeRequest });
    await waitForSolid(() =>
      expect(triggerAlert(page)?.textContent).toBe(
        `Couldn’t load trigger words. Try again. Access denied. Authorization: [redacted]${t("common.retry")}`,
      ),
    );
  });

  it("redacts the Gateway's reason when trigger words fail to save", async () => {
    const { page, input } = await voiceWakeFixture(() => {
      throw new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "Access denied. Authorization: Basic dXNlcjpzdXBlcnNlY3JldHBhc3N3b3Jk",
      });
    });
    editTrigger(input, "hello");
    await tick(400);
    expect(triggerAlert(page)?.textContent).toBe(
      `Couldn’t save trigger words. Try again. Access denied. Authorization: [redacted]${t("common.retry")}`,
    );
  });

  it("retains rejected trigger edits and recovers through retry or typing", async () => {
    const { page, input, voiceWakeRequest } = await voiceWakeFixture((index) => {
      if (index <= 2) {
        throw new Error("Permission denied");
      }
      return { triggers: ["new phrase"] };
    });
    input.focus();
    editTrigger(input, "hello");
    await tick(400);
    expect(triggerAlert(page)?.textContent).toBe(
      `${t("configPage.deviceTalk.triggerWordsSaveFailed")}${t("common.retry")}`,
    );
    expect(page.querySelector(".settings-group [role='alert']")).toBeNull();
    expect(input.value).toBe("hello");
    expect(input.disabled).toBe(false);
    retryTrigger(page);
    expect(voiceWakeRequest).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(0);
    editTrigger(input, "new phrase");
    await tick();
    expect(triggerAlert(page)).toBeNull();
    await tick(400);
    expect(page.querySelector("[role='status']")?.textContent).toBe("Saved");
    expect(triggerInput(page)).toBe(input);
    expect(document.activeElement).toBe(input);
  });

  it("keeps trigger typing focused across an older failure while serializing saves", async () => {
    const first = createDeferred<{ triggers: string[] }>();
    const second = createDeferred<{ triggers: string[] }>();
    const { page, input, writes, voiceWakeRequest } = await voiceWakeFixture((index) =>
      index === 1 ? first.promise : second.promise,
    );
    input.focus();
    editTrigger(input, "first phrase");
    await tick(400);
    expect(input.disabled).toBe(false);
    expect(document.activeElement).toBe(input);
    editTrigger(input, "second phrase");
    await vi.advanceTimersByTimeAsync(400);
    expect(writes()).toBe(1);
    first.reject(new Error("Older edit failed"));
    await tick();
    expectFocused(input, "second phrase");
    expect(triggerAlert(page)).toBeNull();
    expect(page.querySelector("[role='status']")?.textContent).toBe("Saving…");
    expectTriggerWrite(voiceWakeRequest, "second phrase");
    second.resolve({ triggers: ["second phrase"] });
    await tick();
    expect(input.value).toBe("second phrase");
    expect(page.querySelector("[role='status']")?.textContent).toBe("Saved");
  });

  it("leaves Talk while a trigger write is unresolved", async () => {
    const pending = createDeferred<{ triggers: string[] }>();
    const voiceWakeRequest = vi.fn(async (method: string) =>
      method === "voicewake.get" ? { triggers: ["openclaw"] } : pending.promise,
    );
    const { page } = createTalkMutationHarness({ voiceWakeRequest });
    page.remove();
    const sendNotification = vi.fn(async () => undefined);
    const context: ApplicationContext = {
      ...page.context,
      nativeNotifications: {
        snapshot: { permission: "granted", test: null },
        subscribe: () => () => {},
        requestPermission: vi.fn(),
        sendTest: sendNotification,
        backgroundSessionCompleted: vi.fn(),
        dispose: vi.fn(),
      },
    };
    const view = await mountTalkSettingsRoutes(context);
    await waitForSolid(() =>
      expect(view.container.querySelector("textarea")?.value).toBe("openclaw"),
    );
    const configHost = view.container.querySelector("openclaw-config-page");
    const expectNotificationsBody = () => {
      const bodies = view.container.querySelectorAll(
        "#settings-communications-notifications .settings-group",
      );
      expect(bodies).toHaveLength(1);
      expect(bodies[0]?.textContent).toContain(t("configView.notifications.sendTest"));
      expect(view.container.querySelector("openclaw-config-page")).toBe(configHost);
      return bodies[0]!;
    };
    vi.useFakeTimers();
    const input = view.container.querySelector("textarea")!;
    editTrigger(input, "new phrase");
    await vi.advanceTimersByTimeAsync(400);
    expectTriggerWrite(voiceWakeRequest, "new phrase");

    await view.navigate("notifications");
    await vi.advanceTimersByTimeAsync(0);
    expect(view.container.querySelector("h1")?.textContent).toBe("Notifications");
    const notificationsBody = await waitForSolid(expectNotificationsBody);
    const expectDeparted = () => {
      expect(view.container.querySelector("openclaw-talk-settings, textarea")).toBeNull();
      expect(input.isConnected).toBe(false);
    };
    expectDeparted();
    const send = notificationsBody!.querySelector<HTMLButtonElement>("button")!;
    send.click();
    await waitForSolid(() => expect(sendNotification).toHaveBeenCalledOnce());

    pending.resolve({ triggers: ["new phrase"] });
    await vi.advanceTimersByTimeAsync(0);
    await waitForSolid(() => expect(expectNotificationsBody()).toBe(notificationsBody));
    expectDeparted();
  });

  it.each(["latest phrase", "first phrase"])(
    "flushes the latest queued trigger draft on navigation: %s",
    async (latest) => {
      const first = createDeferred<{ triggers: string[] }>();
      const { page, input, voiceWakeRequest, writes } = await voiceWakeFixture((index) =>
        index === 1 ? first.promise : { triggers: [latest] },
      );
      for (const text of ["first phrase", "intermediate phrase"]) {
        editTrigger(input, text);
        await vi.advanceTimersByTimeAsync(400);
      }
      expect(writes()).toBe(1);
      editTrigger(input, latest);
      page.remove();
      first.resolve({ triggers: ["first phrase"] });
      await vi.advanceTimersByTimeAsync(400);
      expectTriggerWrite(voiceWakeRequest, latest);
      expect(writes()).toBe(latest === "first phrase" ? 1 : 2);
    },
  );

  it.each(["debounce", "in-flight"])(
    "preserves the unsaved trigger draft across a same-Gateway %s disconnect",
    async (timing) => {
      const interrupted = createDeferred<{ triggers: string[] }>();
      const { page, input, voiceWakeRequest, setGatewayConnection } = await voiceWakeFixture(
        (index) =>
          timing === "in-flight" && index === 1
            ? interrupted.promise
            : { triggers: ["hello computer"] },
      );
      editTrigger(input, "hello computer");
      await vi.advanceTimersByTimeAsync(timing === "in-flight" ? 400 : 100);
      setGatewayConnection(false);
      await tick();
      expect(triggerInput(page)?.value).toBe("hello computer");
      await waitForSolid(() => expect(triggerAlert(page)?.textContent).toContain("Reconnect"));
      await vi.advanceTimersByTimeAsync(400);
      const priorCalls = voiceWakeRequest.mock.calls.length;
      retryTrigger(page);
      expect(voiceWakeRequest).toHaveBeenCalledTimes(priorCalls);
      setGatewayConnection(true);
      flush();
      expect(triggerInput(page)?.value).toBe("hello computer");
      retryTrigger(page);
      await tick();
      expectTriggerWrite(voiceWakeRequest, "hello computer");
      expect(triggerAlert(page)).toBeNull();
      expect(triggerInput(page)?.value).toBe("hello computer");
      if (timing === "in-flight") {
        interrupted.reject(new Error("Retired connection closed"));
        await vi.advanceTimersByTimeAsync(0);
        expect(triggerAlert(page)).toBeNull();
      }
    },
  );

  it.each([false, true])(
    "restores an offline trigger draft after reopening Talk only for its Gateway (switch: %s)",
    async (switchGateway) => {
      let gatewayWords = ["openclaw"];
      const { page, input, voiceWakeRequest, setGatewayConnection } = await voiceWakeFixture(
        () => ({ triggers: ["retained phrase"] }),
        () => gatewayWords,
      );
      editTrigger(input, "initial phrase");
      setGatewayConnection(false);
      flush();
      editTrigger(input, "retained phrase");
      await vi.advanceTimersByTimeAsync(400);
      page.remove();
      gatewayWords = ["other gateway phrase"];
      setGatewayConnection(true, switchGateway ? "wss://other-gateway.example.test" : undefined);
      const reopened = mountTalkPage(page.context, page.configObject);
      await tick();
      expect(triggerInput(reopened)?.value).toBe(
        switchGateway ? "other gateway phrase" : "retained phrase",
      );
      if (switchGateway) {
        expect(triggerAlert(reopened)).toBeNull();
        expect(voiceWakeRequest).toHaveBeenCalledTimes(2);
      } else {
        expect(triggerAlert(reopened)?.textContent).toContain("not been saved");
        retryTrigger(reopened);
        await tick();
        expectTriggerWrite(voiceWakeRequest, "retained phrase");
        expect(triggerAlert(reopened)).toBeNull();
      }
    },
  );

  it("routes device voice changes to native owners and excludes the primary language from additions", async () => {
    const snapshot = createNativeDeviceSettingsSnapshot();
    snapshot.voice.supported = false;
    snapshot.voice.locale.additional = ["de-DE"];
    const { settings: nativeDeviceSettings, publish: publishSnapshot } = nativeVoice(snapshot);
    const { page, request } = createTalkMutationHarness({ nativeDeviceSettings });
    await waitForSolid(() => expect(request).toHaveBeenCalled());
    flush();
    const rows = settingRows(page);
    const row = (title: string) => rows.find((element) => rowTitle(element) === title)!;
    const expectWakeDisabled = (disabled: boolean) =>
      expect(
        row("Voice wake").querySelector(".settings-toggle__input")?.hasAttribute("disabled"),
      ).toBe(disabled);
    expect(page.textContent).toContain("This Mac");
    expectWakeDisabled(true);
    expect(row("Voice wake").textContent).toContain("macOS 26");
    row("Hold Right Option to talk").click();
    expect(nativeDeviceSettings.set).toHaveBeenCalledWith(
      "voice.pushToTalkEnabled",
      false,
      expect.any(Function),
    );
    const microphone = row("Microphone").querySelector("select")!;
    microphone.value = "builtin";
    microphone.dispatchEvent(new Event("change"));
    expect(nativeDeviceSettings.set).toHaveBeenCalledWith(
      "voice.microphone",
      "builtin",
      expect.any(Function),
    );
    expect(
      [...row("Additional languages").querySelectorAll("option")].map((option) => option.value),
    ).toEqual([""]);
    const primary = row("Primary language").querySelector("select")!;
    primary.value = "de-DE";
    primary.dispatchEvent(new Event("change"));
    expect(nativeDeviceSettings.set).toHaveBeenCalledWith(
      "voice.locale.additional",
      [],
      expect.any(Function),
    );
    expect(nativeDeviceSettings.set).toHaveBeenCalledWith(
      "voice.locale.primary",
      "de-DE",
      expect.any(Function),
    );
    row("Test microphone…").querySelector("button")?.click();
    expect(nativeDeviceSettings.openPanel).toHaveBeenCalledWith("microphone-test");
    snapshot.voice.wakeEnabled = true;
    publishSnapshot();
    await waitForSolid(() => expectWakeDisabled(false));
    row("Voice wake").click();
    expect(nativeDeviceSettings.set).toHaveBeenCalledWith(
      "voice.wakeEnabled",
      false,
      expect.any(Function),
    );
    snapshot.voice.wakeEnabled = false;
    publishSnapshot();
    expectWakeDisabled(true);
    snapshot.voice.supported = true;
    publishSnapshot();
    expectWakeDisabled(false);
  });
});
