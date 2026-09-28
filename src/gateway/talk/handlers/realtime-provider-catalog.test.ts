import { describe, expect, it, vi } from "vitest";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/capability-provider.types.js";
import { buildRealtimeProviderCatalog } from "./realtime-provider-catalog.js";

describe("realtime provider catalog", () => {
  it("keeps healthy provider choices when another provider has an unresolved credential", () => {
    const google = {
      id: "google",
      label: "Google Live Voice",
      defaultModel: "gemini-live-test",
      isConfigured: vi.fn(),
      resolveConfig: vi.fn(),
      createBridge: vi.fn(),
      capabilities: { supportsToolCalls: true, transports: ["gateway-relay"] },
    } as unknown as RealtimeVoiceProviderPlugin;
    const openai = {
      id: "openai",
      label: "OpenAI Realtime",
      isConfigured: vi.fn(),
      resolveConfig: vi.fn(),
      createBridge: vi.fn(),
      capabilities: { supportsToolCalls: true },
    } as unknown as RealtimeVoiceProviderPlugin;

    const catalog = buildRealtimeProviderCatalog({
      providers: [google, openai],
      available: true,
      resolveRawConfig: (provider) => ({ apiKey: `${provider.id}-key` }),
      resolveProviderConfig: (provider, rawConfig) => {
        if (provider.id === "openai") {
          throw new Error("Unresolved secret reference");
        }
        return rawConfig;
      },
      resolveCapabilities: (provider) => provider.capabilities,
      isConfigured: (provider) => provider.id === "google",
    });

    expect(catalog).toEqual([
      expect.objectContaining({ id: "google", configured: true }),
      expect.objectContaining({ id: "openai", configured: false }),
    ]);
    expect(JSON.stringify(catalog)).not.toContain("secret reference");
  });
});
