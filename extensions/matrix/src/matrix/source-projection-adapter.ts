// Provider contract for source projections. Everything below the adapter
// (planning, markers, the source registry) is provider-neutral: it reads
// `ai.cellect.projection.origin {provider, accountId, messageId}` and never
// names a provider. A new source registers one adapter and must pass
// source-projection-conformance.test.ts.
import type { ProjectionExternalSource } from "./projection-source.js";

export type SourceProjectionAdapter = {
  /** `ai.cellect.projection.origin.provider` and the registry provider. */
  readonly provider: string;
  /** Human label for projected author lines and redaction reasons. */
  readonly label: string;
  /** Whether a source message id is well formed for this provider. */
  validMessageId(messageId: string): boolean;
  /** Source timestamp (epoch ms) the message id itself carries, if any. */
  publishedAtMs(messageId: string): number | undefined;
  /** Registry `conversation_ref` for a room's external source. */
  conversationRef(source: ProjectionExternalSource): string;
};

const SLACK_TS = /^\d+\.\d+$/;

export const SLACK_SOURCE_ADAPTER: SourceProjectionAdapter = {
  provider: "slack",
  label: "Slack",
  validMessageId: (messageId) => messageId.length <= 64 && SLACK_TS.test(messageId),
  publishedAtMs: (messageId) =>
    SLACK_TS.test(messageId) ? Math.floor(Number(messageId) * 1000) : undefined,
  // `<channel>:<root ts>`; Fi builds permalinks from it.
  conversationRef: (source) => `${source.channelId}:${source.rootMessageId}`,
};

const adapters = new Map<string, SourceProjectionAdapter>([
  [SLACK_SOURCE_ADAPTER.provider, SLACK_SOURCE_ADAPTER],
]);

/** Adds a source provider. The registry and planner need nothing else. */
export function registerSourceProjectionAdapter(adapter: SourceProjectionAdapter): () => void {
  if (!/^[a-z0-9_-]{1,32}$/.test(adapter.provider)) {
    throw new Error("Source provider must be 1-32 lowercase letters, digits, '-' or '_'");
  }
  const previous = adapters.get(adapter.provider);
  adapters.set(adapter.provider, adapter);
  return () => {
    if (previous) {
      adapters.set(adapter.provider, previous);
    } else {
      adapters.delete(adapter.provider);
    }
  };
}

export function sourceProjectionAdapter(provider: string): SourceProjectionAdapter | undefined {
  return adapters.get(provider);
}
