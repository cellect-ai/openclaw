/**
 * Public SDK surface for document extractor plugins and bundled consumers.
 */
export { extractDocumentContent } from "../media/document-extractors.runtime.js";
export type {
  DocumentExtractedImage,
  DocumentExtractionRequest,
  DocumentExtractionResult,
  DocumentExtractorPlugin,
} from "../plugins/document-extractor-types.js";
