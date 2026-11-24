/**
 * Public SDK surface for document extractor plugins and bundled consumers.
 */
export { extractPdfContent } from "../media/pdf-extract.js";
export type {
  DocumentExtractedImage,
  DocumentExtractionMetadata,
  DocumentExtractionRequest,
  DocumentExtractionResult,
  DocumentExtractorPlugin,
} from "../plugins/document-extractor-types.js";
