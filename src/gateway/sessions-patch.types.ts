import {
  type ErrorShape,
  type SessionsPatchParams,
} from "../../packages/gateway-protocol/src/index.js";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { type ModelCatalogSnapshot } from "../agents/model-catalog.js";
import { type ModelRef } from "../agents/model-selection.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { type SessionCreatedVia } from "../config/sessions/session-entry-provenance.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { UserModelAccountSelection } from "./model-account-authority.js";

export type SessionPatchProjectionParams = {
  cfg: OpenClawConfig;
  creation?: { via: SessionCreatedVia; actor?: SessionEntry["createdActor"] };
  existingEntry?: SessionEntry;
  isLabelInUse: (label: string) => boolean;
  storeKey: string;
  agentId?: string;
  patch: SessionsPatchParams;
  /** Canonical root prepared by the trusted create path; never accepted from public patches. */
  preparedSessionRoot?: string;
  /** Trusted catalog runtime must own selection checks before the new row is persisted. */
  preparedAgentRuntime?: string;
  archivedBy?: SessionEntry["archivedBy"];
  /** Exact harness owner authorized to project its new reserved session row. */
  authorizedAgentHarnessId?: string;
  personalModelSelection?: UserModelAccountSelection;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  /** Resolved spawn identity supplied only by the trusted creation owner. */
  preparedModelSelection?: ModelRef;
};

export type SessionPatchProjectionResult =
  | { ok: true; entry: SessionEntry; validateModelSelection?: () => ErrorShape | undefined }
  | { ok: false; error: ErrorShape };

export type SessionPatchPreparation =
  | { kind: "complete"; result: SessionPatchProjectionResult }
  | {
      kind: "model-catalog";
      finish: (catalog: ModelCatalogSnapshot | undefined) => SessionPatchProjectionResult;
    };
