export const MAX_CHAT_FILES = 5;
export const MAX_CHAT_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_CHAT_MESSAGE_BYTES = 25 * 1024 * 1024;
export const MAX_CHAT_CONTEXT_FILES = 20;
export const MAX_CHAT_DOCUMENT_PAGES = 100;
export const MAX_CHAT_TEXT_CHARACTERS = 100_000;
export const MAX_CHAT_CONTEXT_CHARACTERS = 200_000;
export const CHAT_ATTACHMENT_ACCEPT = ".pdf,.docx,.txt,.md,.csv,.png,.jpg,.jpeg,.webp";

export type ChatAttachmentKind = "document" | "text" | "image";
export type ChatAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  kind: ChatAttachmentKind;
};

const formats: Record<string, { mimeType: string; kind: ChatAttachmentKind; aliases?: string[] }> = {
  pdf: { mimeType: "application/pdf", kind: "document" },
  docx: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "document", aliases: ["application/zip"] },
  txt: { mimeType: "text/plain", kind: "text" },
  md: { mimeType: "text/markdown", kind: "text", aliases: ["text/plain", "text/x-markdown"] },
  csv: { mimeType: "text/csv", kind: "text", aliases: ["text/plain", "application/csv", "application/vnd.ms-excel"] },
  png: { mimeType: "image/png", kind: "image" },
  jpg: { mimeType: "image/jpeg", kind: "image", aliases: ["image/jpg", "image/pjpeg"] },
  jpeg: { mimeType: "image/jpeg", kind: "image", aliases: ["image/jpg", "image/pjpeg"] },
  webp: { mimeType: "image/webp", kind: "image" },
};

export function chatAttachmentFormat(filename: string, declaredMimeType = "") {
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  const format = formats[extension];
  const declared = declaredMimeType.split(";")[0].trim().toLowerCase();
  if (!format || (declared && declared !== "application/octet-stream"
    && declared !== format.mimeType && !format.aliases?.includes(declared))) return null;
  return { mimeType: format.mimeType, kind: format.kind };
}

export function validateChatAttachmentSelection(file: { name: string; type: string; size: number }): string | null {
  if (!file.name.trim() || file.name.length > 180 || /[\x00-\x1f\x7f/\\]/u.test(file.name)) return "Choose a file with a shorter, valid filename.";
  if (!chatAttachmentFormat(file.name, file.type)) return "Choose a PDF, DOCX, TXT, Markdown, CSV, PNG, JPEG, or WebP file.";
  if (!Number.isSafeInteger(file.size) || file.size < 1) return "This file is empty. Choose a file with content.";
  if (file.size > MAX_CHAT_FILE_BYTES) return "Each file must be 10 MB or smaller.";
  return null;
}
