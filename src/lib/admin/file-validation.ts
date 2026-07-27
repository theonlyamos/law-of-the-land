export const ADMIN_DOCUMENT_DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

export const GROUNDX_DOCUMENT_TYPES = {
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

type DocumentFileDescriptor = Pick<File, "name" | "type" | "size">;

export type DocumentFileValidation =
  | { ok: true }
  | { ok: false; reason: "Unsupported file type" | "File is too large" | "File is empty" };

function fileExtension(name: string): string {
  const separator = name.lastIndexOf(".");
  return separator < 0 ? "" : name.slice(separator + 1).toLowerCase();
}

export function validateDocumentFile(
  file: DocumentFileDescriptor,
  maxBytes = ADMIN_DOCUMENT_DEFAULT_MAX_BYTES,
): DocumentFileValidation {
  const extension = fileExtension(file.name);
  const allowedMimes = GROUNDX_DOCUMENT_TYPES[
    extension as keyof typeof GROUNDX_DOCUMENT_TYPES
  ] as readonly string[] | undefined;
  if (!allowedMimes?.includes(file.type.toLowerCase())) {
    return { ok: false, reason: "Unsupported file type" };
  }
  if (file.size < 1) return { ok: false, reason: "File is empty" };
  if (file.size > maxBytes) return { ok: false, reason: "File is too large" };
  return { ok: true };
}

export async function computeFileSha256(file: Blob): Promise<string> {
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
