import type { GatewayScheduledJob, GatewayScheduler } from "../../infra/gateway-scheduler.js";

export type DispatchTerminalReceipt = "accepted" | "stale" | "closed";

/** Retry one retained occurrence; the caller keeps admitted execution until its commit receipt. */
export function persistDispatchTerminal(params: {
  id: string;
  scheduler?: GatewayScheduler;
  publish: () => boolean | Promise<boolean>;
  onFailure: (attempt: number) => void;
}): Promise<DispatchTerminalReceipt> {
  return new Promise((resolve, reject) => {
    let job: GatewayScheduledJob | undefined;
    let settled = false;
    let publishing = false;
    let closing = false;
    let failures = 0;
    const signal = params.scheduler?.signal;
    const finish = (receipt: DispatchTerminalReceipt) => {
      if (settled) return;
      settled = true;
      job?.cancel();
      signal?.removeEventListener("abort", onClose);
      resolve(receipt);
    };
    const onClose = () => {
      closing = true;
      // Accepted native work owns settlement even after its scheduler closes.
      if (!publishing) finish("closed");
    };
    const attempt = async (): Promise<void> => {
      if (settled || publishing) return;
      publishing = true;
      let accepted = false;
      let failure: unknown;
      let failed = false;
      try {
        accepted = await params.publish();
      } catch (error) {
        failed = true;
        failure = error;
      } finally {
        publishing = false;
      }
      if (!failed) {
        finish(accepted ? "accepted" : closing ? "closed" : "stale");
        return;
      }
      if (closing || signal?.aborted) {
        finish("closed");
        return;
      }
      if (!params.scheduler) {
        settled = true;
        signal?.removeEventListener("abort", onClose);
        reject(
          failure instanceof Error
            ? failure
            : new Error("Native dispatch terminal persistence failed.", { cause: failure }),
        );
        return;
      }
      failures += 1;
      try {
        params.onFailure(failures);
      } catch {
        /* Diagnostics cannot release required work. */
      }
      if (signal?.aborted) {
        finish("closed");
        return;
      }
      job = params.scheduler.schedule({
        id: params.id,
        delayMs: Math.min(5_000 * 2 ** Math.min(failures - 1, 6), 300_000),
        run: attempt,
      });
    };
    signal?.addEventListener("abort", onClose, { once: true });
    if (signal?.aborted) onClose();
    else void attempt();
  });
}
