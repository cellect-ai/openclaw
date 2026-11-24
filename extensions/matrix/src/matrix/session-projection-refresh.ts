import {
  getSessionBindingService,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-binding-runtime";
import type { CoreConfig } from "../types.js";
import {
  reconcileMatrixProjectionSnapshot,
  type SourceProjectionSnapshot,
} from "./session-projection-snapshot.js";

export async function maintainExistingProjectionSnapshot(params: {
  cfg: CoreConfig;
  accountId: string;
  roomId: string;
  targetSessionKey: string;
  existing: SessionBindingRecord;
  snapshot?: SourceProjectionSnapshot;
  digest?: string;
  refresh?: boolean;
}): Promise<SessionBindingRecord> {
  const { snapshot, existing } = params;
  if (!snapshot) {
    return existing;
  }
  if (params.refresh) {
    await reconcileMatrixProjectionSnapshot({
      cfg: params.cfg,
      accountId: params.accountId,
      roomId: params.roomId,
      threadId: existing.conversation.conversationId,
      snapshot,
    });
  } else if (existing.metadata?.sourceSnapshotDigest) {
    return existing;
  }
  return getSessionBindingService().bind({
    targetSessionKey: params.targetSessionKey,
    targetKind: "session",
    placement: "current",
    conversation: existing.conversation,
    metadata: {
      ...existing.metadata,
      introText: false,
      sourceSnapshotDigest: params.digest,
      sourceSnapshotReconciledAtMs: Date.now(),
    },
  });
}
