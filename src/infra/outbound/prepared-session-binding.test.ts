import { afterEach, expect, it, vi } from "vitest";
import * as workerContext from "../../state/openclaw-state-worker-context.js";
import { createSqliteCommitReceipt, type SqliteCommitSource } from "../sqlite-commit-receipt.js";
import * as bindingStore from "./current-conversation-bindings.js";
import { currentConversationBindingPublication } from "./current-conversation-bindings.publication.js";
import { prepareSessionBindingSelection } from "./prepared-session-binding.js";
import { nativeSessionBindingInspection } from "./session-binding-native-selection.js";
import type {
  SessionBindingAdapter,
  SessionBindingAdapterV2,
  SessionBindingRecord,
} from "./session-binding.types.js";

afterEach(() => vi.restoreAllMocks());

it.each(["unchanged", "published", "unknown", "missing", "receipt", "unknown-facts"] as const)(
  "retains overlapping prepared ownership blockers until %s settlement",
  async (outcome) => {
    type Listener = Parameters<typeof currentConversationBindingPublication.subscribeFacts>[0];
    let notify: Listener = () => {
      throw new Error("Prepared fact listener was not installed");
    };
    const unsubscribe = vi.fn();
    vi.spyOn(currentConversationBindingPublication, "subscribeFacts").mockImplementation(
      (listener) => {
        notify = listener;
        return unsubscribe;
      },
    );
    const conversation = { channel: "fixture", accountId: "default", conversationId: "prepared" };
    const adapter: SessionBindingAdapter = {
      ...conversation,
      listBySession: () => [],
      resolveByConversation: () => null,
    };
    const assertCurrent = vi.fn();
    const prepared = await prepareSessionBindingSelection([conversation], {
      resolveAdapterForChannelAccount: () => adapter,
      assertAdapterSelectionCurrent: assertCurrent,
      isAsyncAdapter: (value): value is SessionBindingAdapterV2 =>
        "version" in value && value.version === 2,
      availableBindingInspection: (_conversation, binding) => ({ status: "available", binding }),
    });
    const first = {};
    const second = {};
    const identity = "prepared-test-database";
    try {
      expect(prepared.inspect()).toEqual([{ status: "available", binding: null }]);
      notify({ kind: "pending", identity, operation: first });
      notify({ kind: "pending", identity, operation: second });
      notify({ kind: "settled", identity, operation: first, outcome: "unchanged" });
      expect(() => prepared.inspect()).toThrow("ownership changed");
      // An unrelated settlement cannot clear the second operation's ownership fence.
      notify({ kind: "settled", identity, operation: {}, outcome: "unchanged" });
      expect(() => prepared.inspect()).toThrow("ownership changed");
      if (outcome === "receipt") {
        notify({
          receipt: createSqliteCommitReceipt<SessionBindingRecord, SqliteCommitSource>({
            source: { identity, incarnation: "prepared-test-incarnation" },
            domain: "current-conversation-bindings",
            keys: ["prepared-reference"],
            readFact: () => ({ kind: "absent" }),
          }),
          sessionKeys: [],
        });
      } else if (outcome === "unknown-facts") {
        notify({ kind: "unknown", identity });
      }
      notify({
        kind: "settled",
        identity,
        operation: second,
        outcome:
          outcome === "receipt" || outcome === "unknown-facts"
            ? "unchanged"
            : outcome === "missing"
              ? undefined
              : outcome,
      });
      if (outcome === "unchanged") {
        expect(prepared.inspect()).toEqual([{ status: "available", binding: null }]);
        expect(assertCurrent).toHaveBeenCalledTimes(2);
      } else {
        expect(() => prepared.inspect()).toThrow("ownership changed");
      }
    } finally {
      prepared.dispose();
    }
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(() => prepared.inspect()).toThrow("no longer active");
  },
);

it.each(["v2-only", "mixed-native"] as const)(
  "keeps storage-owner invalidation scoped for %s selections",
  async (kind) => {
    type Listener = Parameters<typeof currentConversationBindingPublication.subscribeFacts>[0];
    let notify: Listener = () => {};
    vi.spyOn(currentConversationBindingPublication, "subscribeFacts").mockImplementation(
      (listener) => {
        notify = listener;
        return () => {};
      },
    );
    vi.spyOn(workerContext, "captureOpenClawStateWorkerContext").mockReturnValue({
      admission: { assertCurrent() {} },
    } as never);
    vi.spyOn(bindingStore, "readCurrentConversationBindingSelectionAsync").mockResolvedValue([
      null,
    ]);
    let generation = 1;
    const conversation = { channel: "matrix", accountId: "default", conversationId: "thread" };
    const adapter: SessionBindingAdapterV2 = {
      channel: "matrix",
      accountId: "default",
      version: 2,
      assertCurrent() {},
      listBySession: () => [],
      resolveByConversation: () => null,
      listBySessionAsync: async () => [],
      resolveByConversationAsync: async () => null,
      inspectByConversationAsync: async () => null,
      inspectByConversationsAsync: async (refs) => {
        const captured = generation;
        return {
          bindings: refs.map(() => null),
          assertCurrent() {
            if (generation !== captured) throw new Error("record generation changed");
          },
        };
      },
      touchAsync: async () => {},
    };
    let current: SessionBindingAdapter = adapter;
    const nativeAdapter = {
      channel: "native",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: () => null,
      [nativeSessionBindingInspection]: {
        capture: (ref: typeof conversation) => ref,
        assertCurrent() {},
      },
    };
    const nativeRef = { ...conversation, channel: "native" };
    const prepared = await prepareSessionBindingSelection(
      kind === "mixed-native" ? [conversation, nativeRef] : [conversation],
      {
        resolveAdapterForChannelAccount: (scope) =>
          scope.channel === "native" ? nativeAdapter : current,
        assertAdapterSelectionCurrent: (scope, selected) => {
          if (scope.channel === "matrix" && selected !== current)
            throw new Error("adapter replaced");
        },
        isAsyncAdapter: (value): value is SessionBindingAdapterV2 =>
          "version" in value && value.version === 2,
        availableBindingInspection: (_ref, binding) => ({ status: "available", binding }),
      },
    );
    try {
      expect(prepared.inspect()).toHaveLength(kind === "mixed-native" ? 2 : 1);
      const operation = {};
      notify({ kind: "pending", identity: "unrelated-generic-store", operation });
      if (kind === "mixed-native") {
        expect(() => prepared.inspect()).toThrow("ownership changed");
      } else {
        expect(prepared.inspect()).toHaveLength(1);
      }
      notify({
        kind: "settled",
        identity: "unrelated-generic-store",
        operation,
        outcome: "published",
      });
      if (kind === "mixed-native") {
        expect(() => prepared.inspect()).toThrow("ownership changed");
        return;
      }
      expect(prepared.inspect()).toHaveLength(1);
      generation++;
      expect(() => prepared.inspect()).toThrow("record generation changed");
      generation--;
      current = { ...adapter };
      expect(() => prepared.inspect()).toThrow("adapter replaced");
    } finally {
      prepared.dispose();
    }
  },
);

it("keeps unavailable adapter selection currentness after unrelated generic publication", async () => {
  vi.spyOn(bindingStore, "requiresRegisteredSessionBindingAdapter").mockReturnValue(true);
  type Listener = Parameters<typeof currentConversationBindingPublication.subscribeFacts>[0];
  let notify: Listener = () => {};
  vi.spyOn(currentConversationBindingPublication, "subscribeFacts").mockImplementation(
    (listener) => {
      notify = listener;
      return () => {};
    },
  );
  let current = true;
  const conversation = { channel: "matrix", accountId: "default", conversationId: "unavailable" };
  const prepared = await prepareSessionBindingSelection([conversation], {
    resolveAdapterForChannelAccount: () => null,
    assertAdapterSelectionCurrent: () => {
      if (!current) throw new Error("adapter selection replaced");
    },
    isAsyncAdapter: (_value): _value is SessionBindingAdapterV2 => false,
    availableBindingInspection: (_ref, binding) => ({ status: "available", binding }),
  });
  try {
    notify({ kind: "unknown", identity: "unrelated-store" });
    expect(prepared.inspect()[0]?.status).toBe("unavailable");
    current = false;
    expect(() => prepared.inspect()).toThrow("adapter selection replaced");
  } finally {
    prepared.dispose();
  }
});
