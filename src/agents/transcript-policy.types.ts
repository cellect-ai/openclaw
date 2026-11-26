import type { ToolCallIdMode } from "./tool-call-id.js";

/** Scope of transcript content sanitization before provider replay. */
type TranscriptSanitizeMode = "full" | "images-only";

/** Effective replay policy applied before sending transcript history to a provider. */
export type TranscriptPolicy = {
  sanitizeMode: TranscriptSanitizeMode;
  sanitizeToolCallIds: boolean;
  toolCallIdMode?: ToolCallIdMode;
  duplicateToolCallIdStyle?: "openai";
  preserveNativeAnthropicToolUseIds: boolean;
  repairToolUseResultPairing: boolean;
  preserveSignatures: boolean;
  appendOnlyRuntimeContext?: boolean;
  /**
   * The route accepts mid-conversation system messages. Every session pins its system prompt
   * on every route; this only selects how later prompt deltas are carried: an in-history
   * system message when true, otherwise a user-role note.
   */
  inHistorySystemUpdates?: boolean;
  /**
   * Keep one system prompt per session and send later prompt changes as appended deltas.
   * The delta is an in-history system message when `inHistorySystemUpdates` allows it,
   * otherwise a user-role note.
   */
  pinnedSystemPrompt?: boolean;
  sanitizeThoughtSignatures?: {
    allowBase64Only?: boolean;
    includeCamelCase?: boolean;
  };
  dropThinkingBlocks: boolean;
  dropReasoningFromHistory?: boolean;
  applyGoogleTurnOrdering: boolean;
  validateGeminiTurns: boolean;
  validateAnthropicTurns: boolean;
  allowSyntheticToolResults: boolean;
};
