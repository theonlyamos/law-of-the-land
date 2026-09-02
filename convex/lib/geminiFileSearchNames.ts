const GEMINI_RESOURCE_ID = "[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?";
const STORE_NAME = new RegExp(`^fileSearchStores/(${GEMINI_RESOURCE_ID})$`, "u");
const DOCUMENT_NAME = new RegExp(
  `^fileSearchStores/(${GEMINI_RESOURCE_ID})/documents/(${GEMINI_RESOURCE_ID})$`,
  "u",
);
const UPLOAD_OPERATION_NAME = new RegExp(
  `^fileSearchStores/(${GEMINI_RESOURCE_ID})/upload/operations/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$`,
  "u",
);

export function isGeminiFileSearchStoreName(value: string): boolean {
  return parseGeminiFileSearchStoreName(value) !== null;
}

export function isGeminiDocumentName(value: string): boolean {
  return parseGeminiDocumentName(value) !== null;
}

export function parseGeminiFileSearchStoreName(value: string): { storeId: string } | null {
  const match = STORE_NAME.exec(value);
  return match === null ? null : { storeId: match[1] };
}

export function parseGeminiDocumentName(value: string): {
  storeName: string;
  documentId: string;
} | null {
  const match = DOCUMENT_NAME.exec(value);
  return match === null
    ? null
    : { storeName: `fileSearchStores/${match[1]}`, documentId: match[2] };
}

export function parseGeminiUploadOperationName(value: string): {
  storeName: string;
  operationId: string;
} | null {
  const match = UPLOAD_OPERATION_NAME.exec(value);
  return match === null
    ? null
    : { storeName: `fileSearchStores/${match[1]}`, operationId: match[2] };
}

export function isGeminiUploadOperationForStore(value: string, storeName: string): boolean {
  const parsed = parseGeminiUploadOperationName(value);
  return parsed !== null && parsed.storeName === storeName;
}
