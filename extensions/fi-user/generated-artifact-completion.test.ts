import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { registerGeneratedArtifactCompletion } from "./generated-artifact-completion.js";
import fiUserPlugin from "./index.js";

type Hook = (event: never, context: never) => unknown;
const sessionKey = "agent:cellect-fi-user:slack:direct:UFIXTURE01";
const runId = "run-one";
const artifactId = "ga_12345678-1234-4234-8234-123456789abc";
const sha256 = "a".repeat(64);
let rows: Map<string, unknown>;
let hooks: Map<string, Hook>;
let compareAndApply: ReturnType<typeof vi.fn>;
let observe: Mock<(key: string) => Promise<{ value: unknown; comparison: string }>>;
let lookup: ReturnType<typeof vi.fn>;

beforeEach(() => {
  rows = new Map();
  hooks = new Map();
  const revisions = new Map<string, number>();
  const current = (key: string) => ({
    value: rows.get(key),
    comparison: String(revisions.get(key) ?? 0),
  });
  observe = vi.fn(async (key: string) => current(key));
  compareAndApply = vi.fn(async (key: string, comparison: string, intent: { value: unknown }) => {
    if (comparison !== current(key).comparison)
      return { status: "conflict", current: current(key) };
    rows.set(key, intent.value);
    revisions.set(key, (revisions.get(key) ?? 0) + 1);
    return { status: "applied" };
  });
  lookup = vi.fn(async (key: string) => rows.get(key));
  registerGeneratedArtifactCompletion(
    createTestPluginApi({
      id: "fi-user",
      runtime: {
        state: { openKeyedStore: () => ({ observe, compareAndApply, lookup }) },
      } as unknown as OpenClawPluginApi["runtime"],
      on: (name, handler) => {
        hooks.set(name, handler as Hook);
      },
    }),
  );
});
async function after(
  params: Record<string, unknown>,
  details?: unknown,
  error?: string,
  options: { session?: string; run?: string; tool?: string } = {},
) {
  return hooks.get("after_tool_call")!(
    {
      toolName: options.tool ?? "fi_user_deliver_file",
      params,
      result: details === undefined ? undefined : { details },
      error,
      runId: options.run ?? runId,
    } as never,
    {
      sessionKey: options.session ?? sessionKey,
      runId: options.run ?? runId,
      toolName: options.tool ?? "fi_user_deliver_file",
    } as never,
  );
}
async function final(
  options: { session?: string; run?: string; kind?: string; text?: string } = {},
) {
  return hooks.get("reply_payload_sending")!(
    {
      kind: options.kind ?? "final",
      sessionKey: options.session ?? sessionKey,
      runId: options.run ?? runId,
      payload: { text: options.text ?? "Done — your workbook is ready to download." },
    } as never,
    {
      channelId: "slack",
      sessionKey: options.session ?? sessionKey,
      runId: options.run ?? runId,
    } as never,
  );
}
const register = (id = artifactId, hash = sha256, filename = "Budget.xlsx") =>
  after(
    { action: "register", fileName: filename },
    { status: "generated_not_delivered", artifactId: id, fileName: filename, sha256: hash },
  );
const deliver = (id = artifactId) =>
  after(
    { action: "deliver", artifactId: id },
    { delivered: "slack_dm", artifactId: id, messageId: "1792000000.100000" },
  );
const incomplete = () =>
  expect.objectContaining({
    payload: expect.objectContaining({ text: expect.stringContaining("this task is incomplete") }),
  });

describe("registered generated-artifact completion hooks", () => {
  it("awaits concurrent fire-and-forget delivery through the registered production hooks", async () => {
    const registered = new Map<string, Hook[]>();
    fiUserPlugin.register?.(
      createTestPluginApi({
        id: "fi-user",
        name: "Fi User Delegation",
        runtime: {
          state: { openKeyedStore: () => ({ observe, compareAndApply, lookup }) },
          channel: { runtimeContexts: { register: vi.fn() } },
        } as unknown as OpenClawPluginApi["runtime"],
        on: (name, handler) =>
          registered.set(name, [...(registered.get(name) ?? []), handler as Hook]),
      }),
    );
    const producer = registered.get("after_tool_call")![0];
    if (!producer) throw new Error("Expected the registered production observation hook");
    const context = {
      agentId: "cellect-fi-user",
      sessionKey,
      runId,
      toolName: "fi_user_deliver_file",
    };
    await producer(
      {
        toolName: "fi_user_deliver_file",
        params: { action: "register", fileName: "Budget.xlsx" },
        result: { details: { status: "generated_not_delivered", artifactId, sha256 } },
        runId,
      } as never,
      context as never,
    );
    const originalObserve = observe.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    observe.mockImplementationOnce(async (key: string) => {
      await gate;
      return originalObserve(key);
    });
    const deliveryObservation = producer(
      {
        toolName: "fi_user_deliver_file",
        params: { action: "deliver", artifactId },
        result: { details: { delivered: "slack_dm", artifactId, messageId: "receipt" } },
        runId,
      } as never,
      context as never,
    );
    let settled = false;
    const guarded = Promise.all(
      (registered.get("reply_payload_sending") ?? []).map((handler) =>
        handler(
          { kind: "final", sessionKey, runId, payload: { text: "Delivered" } } as never,
          { channelId: "slack", sessionKey, runId } as never,
        ),
      ),
    ).then((results) => {
      settled = true;
      return results;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await deliveryObservation;
    expect(await guarded).not.toContainEqual(incomplete());
  });
  it("preserves observation order when prepare, register and delivery hooks overlap", async () => {
    const originalObserve = observe.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    observe.mockImplementationOnce(async (key: string) => {
      await gate;
      return originalObserve(key);
    });
    const preparation = after({ action: "prepare" }, { status: "ready" });
    const registration = register();
    const delivery = deliver();
    const guarded = final();
    release();
    await Promise.all([preparation, registration, delivery]);
    expect(await guarded).toBeUndefined();
  });
  it("does not treat an observation timeout as a completed delivery", async () => {
    vi.useFakeTimers();
    try {
      await register();
      const originalObserve = observe.getMockImplementation()!;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      observe.mockImplementationOnce(async (key: string) => {
        await gate;
        return originalObserve(key);
      });
      const pending = deliver();
      const guarded = final();
      await vi.advanceTimersByTimeAsync(8000);
      expect(await guarded).toEqual(incomplete());
      release();
      await pending;
      expect(await final()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
  it("registers the actual producer and final-output boundary hooks", () => {
    expect([...hooks.keys()]).toEqual(["after_tool_call", "reply_payload_sending"]);
  });
  it("guards final completion through the registered production plugin entry point", async () => {
    const registered = new Map<string, Hook[]>();
    fiUserPlugin.register?.(
      createTestPluginApi({
        id: "fi-user",
        name: "Fi User Delegation",
        runtime: {
          state: { openKeyedStore: () => ({ observe, compareAndApply, lookup }) },
          channel: { runtimeContexts: { register: vi.fn() } },
        } as unknown as OpenClawPluginApi["runtime"],
        on: (name, handler) =>
          registered.set(name, [...(registered.get(name) ?? []), handler as Hook]),
      }),
    );
    const afterHooks = registered.get("after_tool_call") ?? [];
    expect(afterHooks.length).toBeGreaterThan(0);
    for (const handler of afterHooks) {
      await handler(
        {
          toolName: "fi_user_deliver_file",
          params: { action: "prepare" },
          result: { details: { status: "ready" } },
          runId,
        } as never,
        {
          agentId: "cellect-fi-user",
          sessionKey,
          runId,
          toolName: "fi_user_deliver_file",
        } as never,
      );
    }
    const results = [];
    for (const handler of registered.get("reply_payload_sending") ?? []) {
      results.push(
        await handler(
          { kind: "final", sessionKey, runId, payload: { text: "Done" } } as never,
          { channelId: "slack", sessionKey, runId } as never,
        ),
      );
    }
    expect(results).toContainEqual(incomplete());
  });
  it("replaces a completion claim after preparing but not delivering output", async () => {
    await after(
      { action: "prepare" },
      { status: "ready", outputDirectory: "/workspace/generated" },
    );
    expect(await final()).toEqual(incomplete());
  });
  it("requires a successful receipt after registration, not merely generated bytes", async () => {
    await register();
    expect(await final()).toEqual(incomplete());
    await deliver();
    expect(await final()).toBeUndefined();
  });
  it("keeps failed registration incomplete and allows a verified replacement of that filename", async () => {
    await after(
      { action: "register", fileName: "Budget.xlsx" },
      undefined,
      "Invalid Office package",
    );
    expect(await final()).toEqual(incomplete());
    await register();
    await deliver();
    expect(await final()).toBeUndefined();
  });
  it("does not clear another failed filename when a different artifact completes", async () => {
    await after({ action: "register", fileName: "Missing.xlsx" }, undefined, "File missing");
    await register();
    await deliver();
    expect(await final()).toEqual(incomplete());
  });
  it("requires receipts for all artifacts in the current run", async () => {
    const other = "ga_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await register();
    await register(other, "b".repeat(64), "Other.xlsx");
    await deliver();
    expect(await final()).toEqual(incomplete());
    await deliver(other);
    expect(await final()).toBeUndefined();
  });
  it("does not accept a message receipt for a different artifact or from an errored call", async () => {
    await register();
    await after(
      { action: "deliver", artifactId },
      { delivered: "slack_dm", artifactId: "another-artifact", messageId: "receipt" },
    );
    expect(await final()).toEqual(incomplete());
    await after(
      { action: "deliver", artifactId },
      { delivered: "slack_dm", artifactId, messageId: "receipt" },
      "Delivery uncertain",
    );
    expect(await final()).toEqual(incomplete());
  });
  it("allows a verified Library filing receipt for the same generated bytes", async () => {
    await register();
    await after(
      { action: "upload_to_project_library", artifactId },
      {
        document: { documentId: "doc-1" },
        filingReceipt: { documentId: "doc-1", sha256, provenance: { artifactId } },
      },
      undefined,
      { tool: "fi_user_dataroom" },
    );
    expect(await final()).toBeUndefined();
  });
  it("allows a verified room filing receipt", async () => {
    await register();
    await after(
      { action: "upload_generated_artifact", artifactId },
      { documentId: "doc-1", filingReceipt: { documentId: "doc-1", sha256 } },
      undefined,
      { tool: "fi_user_dataroom" },
    );
    expect(await final()).toBeUndefined();
  });
  it("does not accept filing claims with missing or mismatched byte-bound receipts", async () => {
    await register();
    await after(
      { action: "upload_generated_artifact", artifactId },
      { documentId: "doc-1" },
      undefined,
      { tool: "fi_user_dataroom" },
    );
    expect(await final()).toEqual(incomplete());
    await after(
      { action: "upload_generated_artifact", artifactId },
      { filingReceipt: { documentId: "doc-1", sha256: "b".repeat(64) } },
      undefined,
      { tool: "fi_user_dataroom" },
    );
    expect(await final()).toEqual(incomplete());
    await after(
      { action: "upload_generated_artifact", artifactId },
      { documentId: "different-document", filingReceipt: { documentId: "doc-1", sha256 } },
      undefined,
      { tool: "fi_user_dataroom" },
    );
    expect(await final()).toEqual(incomplete());
  });
  it("preserves other runs, sessions, admin replies and normal document reads", async () => {
    await register();
    expect(await final({ run: "run-two" })).toBeUndefined();
    expect(await final({ session: "agent:cellect-fi-user:slack:direct:UOTHER01" })).toBeUndefined();
    expect(
      await final({ session: "agent:cellect-fi-admin:slack:direct:UFIXTURE01" }),
    ).toBeUndefined();
    expect(await final({ kind: "tool" })).toBeUndefined();
    await after(
      { documentId: "existing-doc", project: "project" },
      { delivered: "slack_dm", messageId: "message" },
      undefined,
      { run: "normal-read" },
    );
    expect(await final({ run: "normal-read" })).toBeUndefined();
  });
  it("does not turn corrupt stored observations into successful completion", async () => {
    await register();
    const runKey = [...rows.keys()][0];
    if (!runKey) throw new Error("Expected a stored run observation");
    rows.set(runKey, { started: true, pending: "corrupt" });
    await deliver();
    expect(await final()).toEqual(incomplete());
  });
  it("fails explicitly incomplete if observation writes or reads fail after this run started", async () => {
    compareAndApply.mockRejectedValueOnce(new Error("State unavailable"));
    await register();
    expect(await final()).toEqual(incomplete());
    lookup.mockRejectedValue(new Error("State unavailable"));
    expect(await final()).toEqual(incomplete());
    expect(await final({ run: "unrelated" })).toBeUndefined();
  });
  it("does not let an earlier successful observation conceal a later failed registration write", async () => {
    await register();
    await deliver();
    compareAndApply.mockRejectedValueOnce(new Error("State write failed"));
    await after({ action: "register", fileName: "Other.xlsx" }, undefined, "File invalid");
    expect(await final()).toEqual(incomplete());
  });
  it("accepts an attested reconciled delivery receipt", async () => {
    await register();
    await after(
      { action: "reconcile", artifactId },
      { delivered: "slack_dm", artifactId, messageId: "receipt", reconciled: true },
    );
    expect(await final()).toBeUndefined();
  });
  it("replans only an explicit storage conflict using its authoritative current observation", async () => {
    compareAndApply.mockResolvedValueOnce({
      status: "conflict",
      current: { value: undefined, comparison: "0" },
    });
    await register();
    expect(compareAndApply).toHaveBeenCalledTimes(2);
    expect(await final()).toEqual(incomplete());
    await deliver();
    expect(await final()).toBeUndefined();
  });
  it("fails incomplete after bounded repeated conflicts rather than dropping the observation", async () => {
    compareAndApply.mockResolvedValue({
      status: "conflict",
      current: { value: undefined, comparison: "0" },
    });
    await register();
    expect(compareAndApply).toHaveBeenCalledTimes(8);
    expect(await final()).toEqual(incomplete());
  });
  it("ignores a different host agent even if its session string carries the Fi-user prefix", async () => {
    await hooks.get("after_tool_call")!(
      { toolName: "fi_user_deliver_file", params: { action: "prepare" }, runId } as never,
      { agentId: "cellect-fi-admin", sessionKey, runId, toolName: "fi_user_deliver_file" } as never,
    );
    expect(observe).not.toHaveBeenCalled();
    expect(await final()).toBeUndefined();
  });
});
