import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

/** Deterministic durable-owner contract fixture; each test owns its maps. */
export function approvalStores(initial: Record<string, unknown> = {}) {
  const namespaces = new Map<string, Map<string, unknown>>([
    ["admin-actions", new Map(Object.entries(initial))],
    ["admin-action-claims", new Map()],
  ]);
  let failWrites = false;
  function openKeyedStore<T>({ namespace }: { namespace: string }): PluginStateKeyedStore<T> {
    const values = namespaces.get(namespace) ?? new Map<string, unknown>();
    namespaces.set(namespace, values);
    function bound(assertCurrent: () => void = () => {}) {
      const owner = {
        lookup: async (key: string) => structuredClone(values.get(key)) as T | undefined,
        entries: async () => [...values].map(([key, value]) => ({ key, value, createdAt: 1 })),
        register: async (key: string, value: T) => {
          assertCurrent();
          if (failWrites) throw new Error("storage unavailable");
          values.set(key, structuredClone(value));
        },
        registerIfAbsent: async (key: string, value: T) => {
          assertCurrent();
          if (failWrites) throw new Error("storage unavailable");
          if (values.has(key)) return false;
          values.set(key, structuredClone(value));
          return true;
        },
        observe: async (key: string) => ({
          value: structuredClone(values.get(key)),
          comparison: JSON.stringify(values.get(key)),
        }),
        compareAndApply: async (key: string, comparison: string, intent: { value: T }) => {
          assertCurrent();
          if (failWrites) throw new Error("storage unavailable");
          if (JSON.stringify(values.get(key)) !== comparison) return { status: "conflict" };
          values.set(key, structuredClone(intent.value));
          return { status: "applied" };
        },
        withCurrent: ({ assertCurrent: guard }: { assertCurrent: () => void }) => bound(guard),
      };
      return owner as unknown as PluginStateKeyedStore<T>;
    }
    return bound();
  }
  return {
    openKeyedStore,
    namespaces,
    setFailWrites: (value: boolean) => {
      failWrites = value;
    },
  };
}
