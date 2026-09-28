export function resolveCatalogProviderSelection(
  configuredProvider: string | undefined,
  resolveAutomaticProvider: () => string,
): { activeProvider?: string; ready: boolean } {
  // Provider priority belongs to the runtime resolver; catalog consumers must not infer it from row order.
  return resolveCatalogValue<{ activeProvider?: string; ready: boolean }>(
    () => ({ activeProvider: resolveAutomaticProvider(), ready: true }),
    () => ({ ...(configuredProvider ? { activeProvider: configuredProvider } : {}), ready: false }),
  );
}

export function resolveCatalogValue<T>(resolve: () => T, onFailure: () => T): T {
  try {
    return resolve();
  } catch {
    return onFailure();
  }
}
