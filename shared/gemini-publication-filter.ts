/** Server-derived published-source restriction, never a browser-supplied filter. */
export const PUBLICATION_FILTER_PROTOCOL = "published-v1" as const;
export const MAX_PUBLISHED_FILTER_DOCUMENTS = 64;
export const MAX_PUBLICATION_FILTER_BYTES = 16 * 1024;

export type PublishedDocumentIdentity = { resourceId: string; versionId: string; sha256: string };
export type PublicationFilter = {
  protocol: typeof PUBLICATION_FILTER_PROTOCOL;
  environment: string;
  documents: PublishedDocumentIdentity[];
};

// These alphabets contain no filter operators, wildcards, quotes or escapes.
export function isPublicationMetadataId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(value);
}
export function isPublicationEnvironment(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

export function parsePublicationFilter(value: unknown): PublicationFilter | null {
  if (!record(value) || !exactKeys(value, ["protocol", "environment", "documents"])
    || value.protocol !== PUBLICATION_FILTER_PROTOCOL || !isPublicationEnvironment(value.environment)
    || !Array.isArray(value.documents) || !value.documents.length
    || value.documents.length > MAX_PUBLISHED_FILTER_DOCUMENTS) return null;
  const documents: PublishedDocumentIdentity[] = [], resources = new Set<string>(), versions = new Set<string>();
  for (const document of value.documents) {
    if (!record(document) || !exactKeys(document, ["resourceId", "versionId", "sha256"])
      || !isPublicationMetadataId(document.resourceId) || !isPublicationMetadataId(document.versionId)
      || typeof document.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(document.sha256)
      || resources.has(document.resourceId) || versions.has(document.versionId)) return null;
    resources.add(document.resourceId); versions.add(document.versionId);
    documents.push({ resourceId: document.resourceId, versionId: document.versionId, sha256: document.sha256 });
  }
  return { protocol: PUBLICATION_FILTER_PROTOCOL, environment: value.environment, documents };
}

/** Gemini uses AIP-160 (OR binds more tightly than AND). Parenthesize every
 * branch and tuple. Once any store is restricted, every other store also gets
 * its own jurisdiction branch; a healthy store must never become an OR true.
 * A rejected/oversized restriction throws rather than omitting the filter.
 */
export function buildPublicationMetadataFilter(
  stores: readonly { jurisdictionId: string; publicationFilter?: PublicationFilter }[],
): string | undefined {
  if (!stores.some(store => store.publicationFilter !== undefined)) return undefined;
  let documentCount = 0;
  const jurisdictions = new Set<string>();
  const branches = stores.map(store => {
    if (!isPublicationMetadataId(store.jurisdictionId) || jurisdictions.has(store.jurisdictionId)) {
      throw new Error("GEMINI_PUBLICATION_FILTER_INVALID");
    }
    jurisdictions.add(store.jurisdictionId);
    const scope = `jurisdiction_id="${store.jurisdictionId}"`;
    if (store.publicationFilter === undefined) return `(${scope})`;
    const filter = parsePublicationFilter(store.publicationFilter);
    if (!filter) throw new Error("GEMINI_PUBLICATION_FILTER_INVALID");
    documentCount += filter.documents.length;
    if (documentCount > MAX_PUBLISHED_FILTER_DOCUMENTS) throw new Error("GEMINI_PUBLICATION_FILTER_INVALID");
    const tuples = filter.documents.map(document => `(resource_id="${document.resourceId}" AND version_id="${document.versionId}" AND sha256="${document.sha256}")`);
    return `(${scope} AND environment="${filter.environment}" AND (${tuples.join(" OR ")}))`;
  });
  const filter = `(${branches.join(" OR ")})`;
  if (new TextEncoder().encode(filter).byteLength > MAX_PUBLICATION_FILTER_BYTES) throw new Error("GEMINI_PUBLICATION_FILTER_INVALID");
  return filter;
}

/** Bind the original retrieval scope to final atomic completion. Catalogue
 * ordering is immaterial, but changing any tuple, scope or store invalidates
 * the request. Healthy legacy requests retain their existing proof format.
 */
export async function createPublicationFilterBinding(
  stores: readonly { jurisdictionId: string; storeName?: string; publicationFilter?: PublicationFilter }[],
): Promise<string | undefined> {
  if (buildPublicationMetadataFilter(stores) === undefined) return undefined;
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const canonical = stores.map(store => {
    const filter = store.publicationFilter === undefined ? undefined : parsePublicationFilter(store.publicationFilter)!;
    return { jurisdictionId: store.jurisdictionId, storeName: store.storeName ?? null,
      publicationFilter: filter === undefined ? null : { protocol: filter.protocol, environment: filter.environment,
        documents: [...filter.documents].sort((a, b) => compare(a.resourceId, b.resourceId)
          || compare(a.versionId, b.versionId) || compare(a.sha256, b.sha256)) } };
  }).sort((a, b) => compare(a.jurisdictionId, b.jurisdictionId));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([
    "gemini-publication-filter-binding-v1", canonical,
  ])));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
