import { createHash } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

type Attribution = {
  source?: string | null;
  artifactId?: string;
  sha256?: string;
  sessionId?: string;
};
export type ArtifactFilingReceipt = {
  documentId?: string;
  sha256?: string;
  projectSlug?: string;
  provenance?: Attribution;
  existingContent?: boolean;
  requestedArtifact?: Attribution;
};

export function matchesArtifactReceipt(receipt: ArtifactFilingReceipt, expected: Attribution) {
  const attribution = receipt.existingContent ? receipt.requestedArtifact : receipt.provenance;
  return (
    attribution !== undefined &&
    attribution.source === expected.source &&
    attribution.artifactId === expected.artifactId &&
    attribution.sha256 === expected.sha256 &&
    attribution.sessionId === expected.sessionId
  );
}

export async function frozenArtifactUploadHeaders(
  api: OpenClawPluginApi,
  proposed: { "idempotency-key": string; "if-match"?: string },
  assertCurrent?: () => void,
) {
  const store = api.runtime.state.openKeyedStore<typeof proposed>({
    namespace: "fi-room-file-upload-plans",
    retention: "retained",
  });
  if (!store.withCurrent) {
    throw new Error(
      "This gateway cannot retain a current invocation's upload plan; the file was not uploaded",
    );
  }
  const plans = store.withCurrent({ assertCurrent: () => assertCurrent?.() });
  await plans.registerIfAbsent(proposed["idempotency-key"], proposed);
  return (await plans.lookup(proposed["idempotency-key"])) ?? proposed;
}

export function idempotencyKey(actor: string, operation: unknown): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([actor, operation]))
    .digest("hex");
  return `fi-user:${digest.slice(0, 48)}`;
}

export type UploadProvenance = {
  source?: "slack" | "generated_artifact" | "downloaded_file";
  messageId?: string;
  fileId?: string;
  url?: string;
  artifactId?: string;
  sha256?: string;
  sessionId?: string;
};

export function setUploadProvenance(
  form: FormData,
  provenance: UploadProvenance,
  filename: string,
) {
  form.set("provenanceSource", provenance.source ?? "slack");
  for (const [field, value] of Object.entries({
    provenanceMessageId: provenance.messageId,
    provenanceFileId: provenance.fileId,
    provenanceUrl: provenance.url,
    provenanceArtifactId: provenance.artifactId,
    provenanceSha256: provenance.sha256,
    provenanceSessionId: provenance.sessionId,
  })) {
    if (value) {
      form.set(field, value);
    }
  }
  form.set("provenanceOriginalFilename", filename);
}
