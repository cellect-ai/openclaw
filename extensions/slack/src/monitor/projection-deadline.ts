/** Bound the whole read, including SDK awaits; the dedicated client also disables retries. */
export function createProjectionDeadline(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return async <T>(read: () => Promise<T>): Promise<T> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("Slack snapshot deadline exceeded");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Slack snapshot deadline exceeded")),
            remaining,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}
