/** Source text must come from authenticated provider excerpts or verified original
 * extraction. Answer offsets, source labels and model prose are never quotations. */
export type CitationPassage = { pageNumber: number; quote: string };
export type CitationPreview = { pageNumber?: number; passages?: CitationPassage[] };
export const MAX_CITATION_PASSAGES = 24;
export const MAX_CITATION_PASSAGE_BYTES = 32 * 1024;

export function validCitationPassages(citations: readonly CitationPreview[]): boolean {
  let bytes = 0, count = 0;
  for (const citation of citations) {
    if (citation.passages === undefined) continue;
    if (!Array.isArray(citation.passages) || citation.passages.length === 0) return false;
    for (const passage of citation.passages) {
      if (++count > MAX_CITATION_PASSAGES || !passage || typeof passage.quote !== "string" || !passage.quote.trim()
        || !Number.isSafeInteger(passage.pageNumber) || passage.pageNumber < 1 || passage.pageNumber > 10_000
        || passage.pageNumber !== citation.pageNumber) return false;
      bytes += new TextEncoder().encode(passage.quote).byteLength;
      if (bytes > MAX_CITATION_PASSAGE_BYTES) return false;
    }
  }
  return true;
}

/** Optional suffix preserves existing quote-free completion signatures exactly.
 * JSON string framing preserves lone surrogates rather than letting UTF-8 HMAC
 * encoding collapse them onto a replacement character. */
export function citationPassageProofParts(citations: readonly CitationPreview[]): readonly (string | number)[] {
  if (!citations.some(citation => citation.passages !== undefined)) return [];
  return ["governed-source-passages-v1", citations.length, ...citations.flatMap((citation, index) => [
    index, citation.passages?.length ?? 0, ...(citation.passages ?? []).flatMap(passage => [passage.pageNumber, JSON.stringify(passage.quote)]),
  ])];
}

/** Server proxy capability: never emitted to the browser or placed in a URL. */
export function citationFileProofParts(input: { externalId: string; messageId: string; citationIndex: number; expiresAt: number }): readonly (string | number)[] {
  return ["chat-source-file-v1", input.externalId, input.messageId, input.citationIndex, input.expiresAt];
}
