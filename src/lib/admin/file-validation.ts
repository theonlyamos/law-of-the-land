import {
  GEMINI_DOCUMENT_TYPES,
  GEMINI_MAX_DOCUMENT_BYTES,
} from "../../../shared/gemini-file-types";

export const ADMIN_DOCUMENT_DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

type DocumentFileDescriptor = Pick<File, "name" | "type" | "size">;

export type DocumentFileValidation =
  | { ok: true }
  | { ok: false; reason: string };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileExtension(name: string): string {
  const separator = name.lastIndexOf(".");
  return separator < 0 ? "" : name.slice(separator + 1).toLowerCase();
}

export function validateDocumentFile(
  file: DocumentFileDescriptor,
  maxBytes = ADMIN_DOCUMENT_DEFAULT_MAX_BYTES,
): DocumentFileValidation {
  const extension = fileExtension(file.name);
  const allowedMimes = GEMINI_DOCUMENT_TYPES[
    extension as keyof typeof GEMINI_DOCUMENT_TYPES
  ] as readonly string[] | undefined;
  if (!allowedMimes?.includes(file.type.toLowerCase())) {
    return { ok: false, reason: "Choose a supported PDF, Office, text, image, CSV, TSV, or JSON file." };
  }
  if (file.size < 1) return { ok: false, reason: "File is empty" };
  const effectiveLimit = Math.min(maxBytes, GEMINI_MAX_DOCUMENT_BYTES);
  if (file.size > effectiveLimit) {
    return { ok: false, reason: `Choose a file smaller than ${formatBytes(effectiveLimit)}.` };
  }
  return { ok: true };
}

export async function computeFileSha256(file: Blob): Promise<string> {
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
