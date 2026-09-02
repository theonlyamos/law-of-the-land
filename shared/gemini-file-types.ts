export const GEMINI_MAX_DOCUMENT_BYTES = 100_000_000;

export const GEMINI_DOCUMENT_TYPES = {
  txt: ["text/plain"],
  docx: [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  pptx: [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  xlsx: [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  pdf: ["application/pdf"],
  png: ["image/png"],
  jpg: ["image/jpeg"],
  csv: ["text/csv"],
  tsv: ["text/tab-separated-values"],
  json: ["application/json"],
} as const;

export type GeminiDocumentExtension = keyof typeof GEMINI_DOCUMENT_TYPES;
