import { hashTextSha256 } from "./hash.js";

/** Names identify candidates; they are not evidence of admission or safe retirement. */
export type SandboxGenerationPlan = {
  logicalName: string;
  containerPrefix: string;
  containerName: string;
  configHash: string;
  generationHash: string;
};

/**
 * Derive a bounded Docker/Podman name from the complete logical identity and
 * configuration hash. Persist and verify the full hashes before adopting a
 * named container: a shortened container name alone cannot prove identity.
 */
export function planSandboxGeneration(params: {
  logicalName: string;
  containerPrefix: string;
  configHash: string;
}): SandboxGenerationPlan {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(params.logicalName)) {
    throw new Error("Invalid logical sandbox name");
  }
  if (!/^(?:[a-zA-Z0-9][a-zA-Z0-9_.-]*)?$/.test(params.containerPrefix)) {
    throw new Error("Invalid sandbox container prefix");
  }
  if (!/^[a-f0-9]{64}$/.test(params.configHash)) {
    throw new Error("Invalid sandbox configuration hash");
  }
  const generationHash = hashTextSha256(
    JSON.stringify([
      "sandbox-generation-v1",
      params.containerPrefix,
      params.logicalName,
      params.configHash,
    ]),
  );
  // Preserve the configured prefix for name-based discovery, while reserving
  // at least 128 bits of the digest in the 63-character container name.
  const prefix = params.containerPrefix.slice(0, 29);
  return {
    logicalName: params.logicalName,
    containerPrefix: params.containerPrefix,
    containerName: `${prefix}g-${generationHash.slice(0, 61 - prefix.length)}`,
    configHash: params.configHash,
    generationHash,
  };
}

/** A matching short name is insufficient without all persisted identity facts. */
export function matchesSandboxGeneration(
  plan: SandboxGenerationPlan,
  observed: Partial<SandboxGenerationPlan>,
): boolean {
  return (
    observed.containerName === plan.containerName &&
    observed.logicalName === plan.logicalName &&
    observed.containerPrefix === plan.containerPrefix &&
    observed.configHash === plan.configHash &&
    observed.generationHash === plan.generationHash
  );
}
