export function createReplyOwnerSettlement(
  readBarrier: () => Promise<void> | undefined,
  finishOwner: () => void,
): () => void {
  const settleOwner = (): void => {
    const pending = readBarrier();
    if (!pending) {
      finishOwner();
      return;
    }
    void pending.then(() => {
      if (pending !== readBarrier()) {
        settleOwner();
        return;
      }
      finishOwner();
    });
  };
  return settleOwner;
}
