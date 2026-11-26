import { MATRIX_PROJECTION_CONTENT_KEY } from "../projection-publication.js";
import type { MatrixExtraContentFields } from "./types.js";

/** Caller extras cannot impersonate an admitted Matrix publication. */
export function withMatrixExtraContentFields<T extends Record<string, unknown>>(
  content: T,
  extraContent?: MatrixExtraContentFields,
): T {
  if (!extraContent) {
    return content;
  }
  const { [MATRIX_PROJECTION_CONTENT_KEY]: _forged, ...ordinary } = extraContent;
  return { ...content, ...ordinary };
}
