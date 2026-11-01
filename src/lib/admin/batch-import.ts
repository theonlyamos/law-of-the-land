import { z } from "zod";
import { computeFileSha256, validateDocumentFile } from "./file-validation";

export const MAX_BATCH_DOCUMENTS = 100;

/** A collision is a reason to review the manifest, never permission to merge cases. */
export function normalizeBatchIdentity(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\b(?:versus|vs)\b/g, "v").replace(/[^\p{L}\p{N}]+/gu, "");
}

const requiredText = (maximum: number) => z.string().trim().min(1).max(maximum);
const filenameSchema = requiredText(180).refine(
  (value) => !/[\\/\u0000-\u001f\u007f]/.test(value) && /^.+\.pdf$/i.test(value),
  "Use a PDF filename without a directory path.",
);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Use a valid calendar date in YYYY-MM-DD format.");
const sourceUrlSchema = requiredText(500).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}, "Use an HTTPS source URL without credentials.");

const entrySchema = z.object({
  filename: filenameSchema,
  title: requiredText(300),
  issuer: requiredText(300),
  officialCitation: requiredText(300).refine((value) => normalizeBatchIdentity(value).length > 0, "A citation must identify the case."),
  sourceUrl: sourceUrlSchema,
  topics: z.array(requiredText(80)).max(8),
  effectiveDate: dateSchema.optional(),
  sourceProvenance: requiredText(2000),
  caseAliases: z.array(requiredText(300).refine((value) => normalizeBatchIdentity(value).length > 0, "An alias must identify the case.")).max(25).default([]),
}).strict();

const manifestSchema = z.object({
  version: z.literal(1),
  jurisdictionId: requiredText(128),
  documents: z.array(entrySchema).min(1).max(MAX_BATCH_DOCUMENTS),
}).strict().superRefine((manifest, ctx) => {
  const filenames = new Set<string>();
  const identities = new Map<string, number>();
  manifest.documents.forEach((document, index) => {
    const filenameKey = normalizeBatchIdentity(document.filename);
    if (filenames.has(filenameKey)) {
      ctx.addIssue({ code: "custom", path: ["documents", index, "filename"], message: "Duplicate PDF filename. Each document needs a distinct filename." });
    }
    filenames.add(filenameKey);
    const keys = new Set([document.officialCitation, ...document.caseAliases].map(normalizeBatchIdentity));
    for (const key of keys) {
      const previousIndex = identities.get(key);
      if (previousIndex !== undefined && previousIndex !== index) {
        ctx.addIssue({ code: "custom", path: ["documents", index, "caseAliases"], message: `Case citation or alias overlaps document ${previousIndex + 1}. Review this possible duplicate.` });
      }
      identities.set(key, index);
    }
  });
});

export type BatchImportEntry = z.output<typeof entrySchema>;
export type BatchManifest = z.output<typeof manifestSchema>;

export function parseBatchManifest(raw: string): BatchManifest {
  if (raw.length > 1_000_000) throw new Error("The manifest exceeds the 1 MB text limit.");
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error("The manifest must contain valid JSON.");
  }
  const result = manifestSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`${issue.path.join(".") || "Manifest"}: ${issue.message}`);
  }
  return result.data;
}

export async function fingerprintFile(file: File, maxBytes: number): Promise<{ sha256: string; byteSize: number }> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("The PDF upload limit is not configured.");
  if (!filenameSchema.safeParse(file.name).success) throw new Error("Choose a PDF file without a directory path.");
  const validation = validateDocumentFile({ name: file.name, size: file.size, type: file.type || "application/pdf" }, maxBytes);
  if (!validation.ok) throw new Error(validation.reason);
  const header = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  if (header.length !== 5 || header.some((byte, index) => byte !== [37, 80, 68, 70, 45][index])) {
    throw new Error("The selected file does not have a PDF header.");
  }
  return { sha256: await computeFileSha256(file), byteSize: file.size };
}
