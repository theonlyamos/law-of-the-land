/** Gemini permits at most 20 documents per page. Bound complete inventory proofs
 * separately by pages and documents so sparse/empty pages cannot loop forever.
 * The inventory includes published documents and failed/unpublished provider
 * objects; it is deliberately larger than the 1,024-source retrieval filter.
 * Reaching either bound with more data is never evidence of uniqueness.
 */
export const GEMINI_DOCUMENT_PAGE_SIZE = 20;
export const MAX_GEMINI_DOCUMENT_PAGES = 128;
export const MAX_GEMINI_INVENTORY_DOCUMENTS = 2048;
