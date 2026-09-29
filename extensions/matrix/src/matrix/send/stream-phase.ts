import { MATRIX_STREAM_PHASE_CONTENT_KEY, type MatrixStreamPhase } from "./types.js";

export function applyMatrixStreamPhase(
  content: Record<string, unknown>,
  streamPhase: MatrixStreamPhase | undefined,
  includeReplacement = false,
): void {
  if (!streamPhase) {
    return;
  }
  content[MATRIX_STREAM_PHASE_CONTENT_KEY] = streamPhase;
  const replacement = content["m.new_content"];
  if (includeReplacement && replacement && typeof replacement === "object") {
    (replacement as Record<string, unknown>)[MATRIX_STREAM_PHASE_CONTENT_KEY] = streamPhase;
  }
}
