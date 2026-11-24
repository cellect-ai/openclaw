import { resolveGlobalSingleton } from "../shared/global-singleton.js";

/** Capture once; a retry must reconcile the preceding native attempt before writing again. */
export type AgentRunPersistenceWork = { run: () => Promise<void> };
export type AgentRunPersistenceReceipt = {
  readonly pending: Promise<void>;
  retry: () => Promise<void>;
};
type RequiredReceipt = AgentRunPersistenceReceipt & {
  status: "pending" | "failed" | "committed";
  error?: unknown;
};
type PersistenceState = {
  owners: WeakMap<object, RequiredReceipt[]>;
  unresolved: Set<RequiredReceipt>;
};
function state(): PersistenceState {
  return resolveGlobalSingleton(Symbol.for("openclaw.agentRunRequiredPersistence"), () => ({
    owners: new WeakMap<object, RequiredReceipt[]>(),
    unresolved: new Set<RequiredReceipt>(),
  }));
}

async function join(receipts: readonly AgentRunPersistenceReceipt[]): Promise<void> {
  const outcomes = await Promise.allSettled(receipts.map((receipt) => receipt.pending));
  for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
}

/** Read only this exact registration's unresolved required custody. */
export function readAgentRunPersistence(owner: object): Promise<void> | undefined {
  const receipts = state().owners.get(owner);
  return receipts?.length ? join(receipts) : undefined;
}

export function hasAgentRunPersistence(owner: object): boolean {
  return (state().owners.get(owner)?.length ?? 0) > 0;
}

/** Keep one occurrence through failed attempts, without replacing its position or predecessor. */
export function captureAgentRunPersistence(
  owner: object,
  work: AgentRunPersistenceWork,
): AgentRunPersistenceReceipt {
  const current = state();
  const predecessors = [...(current.owners.get(owner) ?? [])];
  let pending: Promise<void>;
  const start = (retry: boolean): Promise<void> => {
    receipt.status = "pending";
    delete receipt.error;
    pending = Promise.resolve().then(async () => {
      for (const predecessor of predecessors) {
        await (retry ? predecessor.retry() : predecessor.pending);
      }
      await work.run();
    });
    void pending.then(
      () => {
        receipt.status = "committed";
        current.unresolved.delete(receipt);
        const retained = current.owners.get(owner)?.filter((entry) => entry !== receipt);
        if (retained?.length) current.owners.set(owner, retained);
        else current.owners.delete(owner);
      },
      (error: unknown) => {
        receipt.status = "failed";
        receipt.error = error;
      },
    );
    return pending;
  };
  const receipt: RequiredReceipt = {
    status: "pending",
    get pending() {
      return pending;
    },
    retry: () => (receipt.status === "failed" ? start(true) : pending),
  };
  current.owners.set(owner, [...predecessors, receipt]);
  current.unresolved.add(receipt);
  start(false);
  return receipt;
}

/** A released callback returning only a Promise has no replay authority. */
export function retainAgentRunPersistence(owner: object, write: Promise<void>): Promise<void> {
  // Attach a rejection observer immediately, even while predecessors are pending.
  void write.catch(() => undefined);
  return captureAgentRunPersistence(owner, { run: () => write }).pending;
}

/** Close ingress first; unresolved failures remain visible until that occurrence commits. */
export async function drainRequiredAgentRunPersistence(): Promise<void> {
  const current = state();
  while ([...current.unresolved].some((receipt) => receipt.status === "pending")) {
    await Promise.allSettled([...current.unresolved].map((receipt) => receipt.pending));
  }
  const failed = [...current.unresolved].find((receipt) => receipt.status === "failed");
  if (failed) throw failed.error;
}

export function resetRequiredAgentRunPersistenceForTest(): void {
  const current = state();
  current.owners = new WeakMap();
  current.unresolved.clear();
}
