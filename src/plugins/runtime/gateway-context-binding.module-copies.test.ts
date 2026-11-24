import { expect, it, vi } from "vitest";

it("retains the exact Gateway SDK host across separately loaded runtime module graphs", async () => {
  const first = await import("./gateway-context-binding.js");
  const firstHost = await import("../legacy-sdk-resource-host.js");
  const canonical = vi.fn(() => undefined);
  const wrapper = vi.fn(() => undefined);
  const host = new firstHost.LegacyPluginSdkResourceHost();
  firstHost.bindLegacyPluginSdkResourceHost(canonical, host);
  first.bindGatewayContextResolver(wrapper, canonical);
  vi.resetModules();
  const second = await import("./gateway-context-binding.js");
  const secondHost = await import("../legacy-sdk-resource-host.js");
  const scope = await import("./gateway-request-scope.js");
  try {
    const selected = scope.withPluginRuntimeGatewayContextResolver(wrapper, () =>
      secondHost.getBoundLegacyPluginSdkResourceHost(),
    );
    expect(selected).toBe(host);
    expect(second.getCanonicalGatewayContextResolver(wrapper)).toBe(canonical);
    expect(canonical).not.toHaveBeenCalled();
    expect(wrapper).not.toHaveBeenCalled();
  } finally {
    await host.close();
  }
});

it("shares binding reservation and retirement across module copies for frozen owners", async () => {
  const first = await import("./gateway-context-binding.js");
  const reserve = await import("./gateway-context-binding-owner.js");
  const owner = Object.freeze(reserve.prepareGatewayContextBindingOwner({}));
  const canonical = vi.fn(() => undefined);
  first.bindGatewayContextResolver(owner, canonical);
  const lifetime = first.getGatewayContextLifetime(canonical);
  vi.resetModules();
  const second = await import("./gateway-context-binding.js");
  expect(second.getGatewayContextResolver(owner)).toBe(canonical);
  expect(second.getGatewayContextLifetime(canonical)).toBe(lifetime);
  expect(second.clearGatewayContextResolver(owner)).toBe(true);
  expect(first.getGatewayContextResolver(owner)).toBeUndefined();
  lifetime.abort(new Error("Gateway retired"));
  expect(second.getGatewayContextLifetime(canonical).signal.aborted).toBe(true);
});
