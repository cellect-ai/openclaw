import { createHash } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

type RunObservation = {
  started: true;
  prepared: boolean;
  failedFiles: string[];
  pending: Record<string, { sha256?: string }>;
};
const incomplete =
  "File delivery has not been verified. Any generated artifact is retained for recovery; this task is incomplete. I will not present an internal file path as a download or ask you to upload a file you cannot access.";
const initial = (): RunObservation => ({
  started: true,
  prepared: false,
  failedFiles: [],
  pending: {},
});
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const string = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const validHash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function key(sessionKey?: string, runId?: string) {
  if (!sessionKey?.startsWith("agent:cellect-fi-user:") || !runId) return undefined;
  return createHash("sha256")
    .update(JSON.stringify([sessionKey, runId]))
    .digest("hex");
}
function validObservation(value: unknown): value is RunObservation {
  const row = record(value);
  return (
    row?.started === true &&
    typeof row.prepared === "boolean" &&
    Array.isArray(row.failedFiles) &&
    row.failedFiles.every((entry) => typeof entry === "string") &&
    !!record(row.pending) &&
    Object.values(row.pending as Record<string, unknown>).every((entry) => {
      const artifact = record(entry);
      return !!artifact && (artifact.sha256 === undefined || validHash(artifact.sha256));
    })
  );
}

/** Observation only, never delivery/filing authority. Facts come from successful
 * production tool receipts; SQLite owns the bounded per-run projection. */
export function registerGeneratedArtifactCompletion(api: OpenClawPluginApi) {
  const observations = () =>
    api.runtime.state.openKeyedStore<RunObservation>({
      namespace: "generated-artifact-run-observations",
      maxEntries: 4096,
      defaultTtlMs: 24 * 60 * 60 * 1000,
    });
  // A bounded failure witness prevents a failed observation write/read from
  // turning this run into a false success. It carries no artifact or authority.
  const witnessed = new Set<string>();
  const failedObservations = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();
  const witness = (runKey: string) => {
    witnessed.add(runKey);
    if (witnessed.size > 4096) {
      const oldest = witnessed.values().next().value!;
      witnessed.delete(oldest);
      failedObservations.delete(oldest);
    }
  };
  api.on("after_tool_call", async (event, context) => {
    if (context.agentId && context.agentId !== "cellect-fi-user") return;
    const runKey = key(context.sessionKey, event.runId ?? context.runId);
    if (!runKey) return;
    const action = string(event.params.action);
    const artifactId = string(event.params.artifactId);
    const isDelivery =
      event.toolName === "fi_user_deliver_file" &&
      (action === "prepare" || action === "register" || !!artifactId);
    const isFiling =
      event.toolName === "fi_user_dataroom" &&
      !!artifactId &&
      (action === "upload_generated_artifact" || action === "upload_to_project_library");
    if (!isDelivery && !isFiling) return;
    witness(runKey);
    const details = record(record(event.result)?.details);
    const successful = !event.error && record(event.result)?.isError !== true && !!details;
    if (inFlight.size >= 4096 && !inFlight.has(runKey)) {
      failedObservations.add(runKey);
      return;
    }
    const preceding = inFlight.get(runKey);
    const pending = (async () => {
      // Native embedded after-tool hooks are fire-and-forget. Serialize this
      // projection in tool-observation order, not worker response order.
      if (preceding) await preceding;
      try {
        const store = observations();
        if (!store.observe || !store.compareAndApply)
          throw new Error("Data-only run observations are unavailable");
        let observation = await store.observe(runKey);
        for (let attempt = 0; attempt < 8; attempt++) {
          const prior = observation.value;
          // Invalid stored facts are not repaired into success by this projection.
          if (prior !== undefined && !validObservation(prior))
            throw new Error("Invalid generated-file run observation");
          const next = prior === undefined ? initial() : structuredClone(prior);
          if (action === "prepare") next.prepared = true;
          if (action === "register") {
            const filename = string(event.params.fileName) ?? "unidentified output";
            const id = string(details?.artifactId);
            if (
              successful &&
              details?.status === "generated_not_delivered" &&
              id &&
              validHash(details.sha256)
            ) {
              next.prepared = false;
              next.failedFiles = next.failedFiles.filter((name) => name !== filename);
              next.pending[id] = { sha256: details.sha256 };
            } else if (!next.failedFiles.includes(filename)) next.failedFiles.push(filename);
          }
          if (artifactId) {
            next.pending[artifactId] ??= {};
            const delivered =
              successful &&
              details?.delivered === "slack_dm" &&
              details.artifactId === artifactId &&
              !!string(details.messageId);
            const receipt = record(details?.filingReceipt);
            const documentId =
              string(details?.documentId) ?? string(record(details?.document)?.documentId);
            const filed =
              successful &&
              isFiling &&
              !!documentId &&
              receipt?.documentId === documentId &&
              validHash(receipt?.sha256) &&
              (!next.pending[artifactId].sha256 ||
                next.pending[artifactId].sha256 === receipt.sha256);
            if (delivered || filed) delete next.pending[artifactId];
          }
          const applied = await store.compareAndApply(runKey, observation.comparison, {
            operation: "update",
            action: "set",
            value: next,
          });
          if (applied.status !== "conflict") return;
          observation = applied.current;
        }
        throw new Error("Generated-file observation changed repeatedly");
      } catch {
        // The host's observation hook is best-effort. The witness makes the final
        // guard explicitly incomplete if authoritative observation is unavailable.
        failedObservations.add(runKey);
      }
    })();
    inFlight.set(runKey, pending);
    try {
      await pending;
    } finally {
      if (inFlight.get(runKey) === pending) inFlight.delete(runKey);
    }
  });
  api.on("reply_payload_sending", async (event, context) => {
    if (event.kind !== "final") return;
    const runKey = key(event.sessionKey ?? context.sessionKey, event.runId ?? context.runId);
    if (!runKey) return;
    const pending = inFlight.get(runKey);
    const incompleteReply = { payload: { ...event.payload, text: incomplete } };
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const checked = (async () => {
      if (pending) await pending;
      if (expired) return incompleteReply;
      if (failedObservations.has(runKey)) return incompleteReply;
      try {
        const row = await observations().lookup(runKey);
        if (!row && !witnessed.has(runKey)) return;
        if (
          validObservation(row) &&
          !row.prepared &&
          !row.failedFiles.length &&
          !Object.keys(row.pending).length
        )
          return;
      } catch {
        if (!witnessed.has(runKey)) return;
      }
      return incompleteReply;
    })();
    try {
      // The native modifying-hook budget is 15 seconds. This single smaller
      // deadline covers observation settlement AND final storage read, so a
      // stalled worker cannot hit the host's fail-open timeout first.
      return await Promise.race([
        checked,
        new Promise<typeof incompleteReply | undefined>((resolve) => {
          timer = setTimeout(() => {
            expired = true;
            resolve(witnessed.has(runKey) ? incompleteReply : undefined);
          }, 8000);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
}
