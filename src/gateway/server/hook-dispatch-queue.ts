export function createSessionKeyedHookDispatchQueue() {
  const hookAgentDispatchTails = new Map<string, Promise<void>>();

  return (sessionKey: string, operation: () => Promise<void>) => {
    const previousTail = hookAgentDispatchTails.get(sessionKey);
    const run = previousTail ? previousTail.catch(() => undefined).then(operation) : operation();
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    hookAgentDispatchTails.set(sessionKey, tail);
    // Same-session hook agent runs append to one agent session. Serializing avoids
    // optimistic lifecycle-claim races while preserving parallelism across sessions.
    void tail.finally(() => {
      if (hookAgentDispatchTails.get(sessionKey) === tail) {
        hookAgentDispatchTails.delete(sessionKey);
      }
    });
    return run;
  };
}
