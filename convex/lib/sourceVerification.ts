import { ConvexError, v, type Infer } from "convex/values";

export const sourceVerificationInputValidator = v.object({
  sourceClass: v.union(v.literal("official_hosted"), v.literal("corroborated_reproduction")),
  sourceUrl: v.string(),
  verificationNotes: v.string(),
  corroboratingUrls: v.array(v.string()),
  completeOriginal: v.boolean(),
  citationChecked: v.boolean(),
  laterTreatmentChecked: v.boolean(),
});
export type SourceVerificationInput = Infer<typeof sourceVerificationInputValidator>;
export type SourceVerificationAssessment = "verified" | "unresolved";

export const UNRESOLVED_SOURCE_GUIDANCE = "Unpublish with existing guarded workflow before recording unresolved provenance";

function normalizedHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");
}

function sourceUrl(value: string): URL {
  if (!value || value.length > 500) throw new ConvexError("DOCUMENT_SOURCE_URL_INVALID");
  let url: URL;
  try { url = new URL(value); } catch { throw new ConvexError("DOCUMENT_SOURCE_URL_INVALID"); }
  if (url.protocol !== "https:" || url.username || url.password) throw new ConvexError("DOCUMENT_SOURCE_URL_INVALID");
  return url;
}

/** Records a reviewer's assessment; URL shape never establishes authenticity. */
export function validateSourceVerification(
  input: SourceVerificationInput,
  actualVersionSourceUrl: string,
  assessment: SourceVerificationAssessment = "verified",
): SourceVerificationInput {
  if (input.sourceClass !== "official_hosted" && input.sourceClass !== "corroborated_reproduction") {
    throw new ConvexError("DOCUMENT_SOURCE_CLASS_REQUIRED");
  }
  const actualSource = sourceUrl(actualVersionSourceUrl);
  const source = sourceUrl(input.sourceUrl);
  if (source.origin !== actualSource.origin || source.href !== actualSource.href) {
    throw new ConvexError("DOCUMENT_SOURCE_URL_MISMATCH");
  }
  const verificationNotes = input.verificationNotes.trim();
  if (verificationNotes.length < 20 || verificationNotes.length > 2000) throw new ConvexError("DOCUMENT_SOURCE_NOTES_REQUIRED");
  if (input.corroboratingUrls.length > 10) throw new ConvexError("DOCUMENT_SOURCE_TOO_MANY_CORROBORATIONS");
  const corroborating = input.corroboratingUrls.map(sourceUrl);
  const corroboratingUrls = [...new Set(corroborating.map(url => url.href))];
  if (assessment === "verified") {
    if (input.completeOriginal !== true || input.citationChecked !== true || input.laterTreatmentChecked !== true) {
      throw new ConvexError(`DOCUMENT_SOURCE_CHECKS_INCOMPLETE: ${UNRESOLVED_SOURCE_GUIDANCE}`);
    }
    if (input.sourceClass === "corroborated_reproduction" && !corroborating.some(url => normalizedHost(url) !== normalizedHost(actualSource))) {
      throw new ConvexError("DOCUMENT_SOURCE_INDEPENDENT_CORROBORATION_REQUIRED");
    }
  }
  return { ...input, sourceUrl: source.href, verificationNotes, corroboratingUrls };
}
