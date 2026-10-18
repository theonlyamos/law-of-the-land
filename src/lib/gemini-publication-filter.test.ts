import { expect, it } from "vitest";
import { buildPublicationMetadataFilter, parsePublicationFilter, PUBLICATION_FILTER_PROTOCOL,
  MAX_PUBLICATION_FILTER_BYTES, createPublicationFilterBinding, type PublicationFilter } from "../../shared/gemini-publication-filter";

function restriction(count = 1, idSize = 1): PublicationFilter {
  return { protocol: PUBLICATION_FILTER_PROTOCOL, environment: "production", documents: Array.from({ length: count }, (_, index) => ({
    resourceId: `r${String(index).padStart(idSize, "0")}`,
    versionId: `v${String(index).padStart(idSize, "0")}`, sha256: "a".repeat(64),
  })) };
}

// Independent small evaluator for the exact emitted equality grammar: parse
// parentheses explicitly so precedence mistakes cannot let another store's
// broad branch admit a failed document in a restricted store.
function matches(filter: string, metadata: Record<string, string>): boolean {
  const tokens = filter.match(/[()]|AND|OR|[a-z_0-9]+="[A-Za-z0-9._-]+"/gu)!;
  let index = 0;
  function term(): boolean {
    if (tokens[index] === "(") {
      index++; const value = expression();
      if (tokens[index++] !== ")") throw new Error("Unbalanced filter");
      return value;
    }
    const [key, value] = tokens[index++].split("=");
    return metadata[key] === value.slice(1, -1);
  }
  function disjunction(): boolean {
    let value = term();
    while (tokens[index] === "OR") { index++; const right = term(); value = value || right; }
    return value;
  }
  function expression(): boolean {
    let value = disjunction();
    while (tokens[index] === "AND") { index++; const right = disjunction(); value = value && right; }
    return value;
  }
  const value = expression();
  if (index !== tokens.length) throw new Error("Trailing filter tokens");
  return value;
}

it("restricts every recovered-store tuple while retaining only the healthy store's own scope", () => {
  const filter = buildPublicationMetadataFilter([{ jurisdictionId: "ohada", publicationFilter: restriction(2) }, { jurisdictionId: "ghana" }])!;
  const metadata = { jurisdiction_id: "ohada", environment: "production", resource_id: "r0", version_id: "v0", sha256: "a".repeat(64) };
  expect(matches(filter, metadata)).toBe(true);
  expect(matches(filter, { ...metadata, resource_id: "r1", version_id: "v1" })).toBe(true);
  for (const mismatch of [{ resource_id: "failed" }, { version_id: "failed" }, { sha256: "b".repeat(64) }, { environment: "development" },
    { jurisdiction_id: "foreign" }, { resource_id: "r0", version_id: "v1" }]) expect(matches(filter, { ...metadata, ...mismatch })).toBe(false);
  expect(matches(filter, { jurisdiction_id: "ghana", resource_id: "any-healthy-document" })).toBe(true);
  expect(matches(filter, { jurisdiction_id: "ohada", resource_id: "any-healthy-document" })).toBe(false);
});

it("searches all 65 published tuples while excluding failed and mismatched identities", () => {
  const published = restriction(65);
  expect(parsePublicationFilter(published)?.documents).toEqual(published.documents);
  const filter = buildPublicationMetadataFilter([{ jurisdictionId: "ohada", publicationFilter: published }])!;
  for (const document of published.documents) {
    expect(matches(filter, { jurisdiction_id: "ohada", environment: "production",
      resource_id: document.resourceId, version_id: document.versionId, sha256: document.sha256 })).toBe(true);
  }
  const metadata = { jurisdiction_id: "ohada", environment: "production", resource_id: "r64", version_id: "v64", sha256: "a".repeat(64) };
  for (const mismatch of [{ resource_id: "failed" }, { version_id: "failed" }, { version_id: "v0" },
    { sha256: "b".repeat(64) }, { environment: "development" }, { jurisdiction_id: "foreign" }]) {
    expect(matches(filter, { ...metadata, ...mismatch })).toBe(false);
  }
});

it("preserves each library's exact identities in a combined 128-document filter", () => {
  const selected = restriction(64), related = { ...restriction(64), environment: "development" };
  const filter = buildPublicationMetadataFilter([{ jurisdictionId: "ohada", publicationFilter: selected },
    { jurisdictionId: "related", publicationFilter: related }])!;
  expect(filter.match(/resource_id=/gu)).toHaveLength(128);
  for (const [jurisdictionId, published] of [["ohada", selected], ["related", related]] as const) {
    const last = published.documents[63];
    const metadata = { jurisdiction_id: jurisdictionId, environment: published.environment,
      resource_id: last.resourceId, version_id: last.versionId, sha256: last.sha256 };
    expect(matches(filter, metadata)).toBe(true);
    expect(matches(filter, { ...metadata, version_id: "v0" })).toBe(false);
    expect(matches(filter, { ...metadata, environment: jurisdictionId === "ohada" ? "development" : "production" })).toBe(false);
  }
});

it("retains every tuple at the 1024-document single-library limit", async () => {
  const published = restriction(1024), store = { jurisdictionId: "ohada", storeName: "fileSearchStores/ohada", publicationFilter: published };
  expect(parsePublicationFilter(published)?.documents).toEqual(published.documents);
  const filter = buildPublicationMetadataFilter([store])!;
  const tuples = Array.from(filter.matchAll(/\(resource_id="([A-Za-z0-9_-]+)" AND version_id="([A-Za-z0-9_-]+)" AND sha256="([a-f0-9]{64})"\)/gu),
    match => ({ resourceId: match[1], versionId: match[2], sha256: match[3] }));
  expect(tuples).toEqual(published.documents);
  expect(await createPublicationFilterBinding([store])).toMatch(/^[a-f0-9]{64}$/u);
  expect(await createPublicationFilterBinding([{ ...store, publicationFilter: { ...published, documents: [...published.documents].reverse() } }]))
    .toBe(await createPublicationFilterBinding([store]));
});

it("accepts exactly 1024 aggregate tuples and rejects 1025 without truncation", () => {
  const selected = { jurisdictionId: "ohada", publicationFilter: restriction(512) };
  const related = { jurisdictionId: "related", publicationFilter: restriction(512) };
  const filter = buildPublicationMetadataFilter([selected, related])!;
  expect(filter.match(/resource_id=/gu)).toHaveLength(1024);
  for (const jurisdictionId of ["ohada", "related"]) {
    expect(matches(filter, { jurisdiction_id: jurisdictionId, environment: "production",
      resource_id: "r511", version_id: "v511", sha256: "a".repeat(64) })).toBe(true);
  }
  expect(() => buildPublicationMetadataFilter([selected, { ...related, publicationFilter: restriction(513) }]))
    .toThrow("GEMINI_PUBLICATION_FILTER_INVALID");
  expect(parsePublicationFilter(restriction(1025))).toBeNull();
  expect(() => buildPublicationMetadataFilter([{ jurisdictionId: "ohada", publicationFilter: restriction(1025) }]))
    .toThrow("GEMINI_PUBLICATION_FILTER_INVALID");
});

it("enforces the 256 KiB UTF-8 budget independently of the tuple count", () => {
  const restricted = { jurisdictionId: "ohada", publicationFilter: restriction() };
  const encoder = new TextEncoder(), byteLimit = 256 * 1024;
  const baseBytes = encoder.encode(buildPublicationMetadataFilter([restricted])!).byteLength;
  const incrementBytes = (id: string) => encoder.encode(` OR (jurisdiction_id="${id}")`).byteLength;
  const fixedBytes = incrementBytes("t") - 1, minBytes = fixedBytes + 1, maxBytes = fixedBytes + 64;
  const fullBranches = Math.floor((byteLimit - baseBytes - 2 * minBytes) / maxBytes);
  const tailBytes = byteLimit - baseBytes - fullBranches * maxBytes;
  const firstTailBytes = Math.min(maxBytes, tailBytes - minBytes);
  const lastId = "u".repeat(tailBytes - firstTailBytes - fixedBytes);
  // Exercise the builder's byte guard independently. The SDK separately
  // enforces its request store limit, and all valid metadata is ASCII-only.
  const stores = [restricted, ...Array.from({ length: fullBranches }, (_, index) => ({
    jurisdictionId: `j${String(index).padStart(63, "0")}`,
  })), { jurisdictionId: "t".repeat(firstTailBytes - fixedBytes) }, { jurisdictionId: lastId }];
  expect(stores.every(store => store.jurisdictionId.length <= 64)).toBe(true);
  const filter = buildPublicationMetadataFilter(stores)!;
  expect(encoder.encode(filter).byteLength).toBe(byteLimit);
  expect(MAX_PUBLICATION_FILTER_BYTES).toBe(byteLimit);
  expect(filter.match(/resource_id=/gu)).toHaveLength(1);
  expect(lastId.length + 1).toBeLessThanOrEqual(64);
  expect(() => buildPublicationMetadataFilter([...stores.slice(0, -1), { jurisdictionId: `${lastId}u` }]))
    .toThrow("GEMINI_PUBLICATION_FILTER_INVALID");
});

it("rejects duplicate identities, unexpected fields, wildcard operators, null and unknown protocols", () => {
  const valid = restriction();
  for (const value of [null, { ...valid, protocol: "other" }, { ...valid, extra: true }, { ...valid, documents: [...valid.documents, valid.documents[0]] },
    { ...valid, documents: [{ ...valid.documents[0], extra: true }] }, { ...valid, documents: [{ ...valid.documents[0], resourceId: "*" }] }]) {
    expect(parsePublicationFilter(value)).toBeNull();
  }
  expect(() => buildPublicationMetadataFilter([{ jurisdictionId: 'ohada" OR true', publicationFilter: valid }])).toThrow("GEMINI_PUBLICATION_FILTER_INVALID");
  expect(() => buildPublicationMetadataFilter([{ jurisdictionId: "ohada", publicationFilter: valid }, { jurisdictionId: "ohada" }])).toThrow("GEMINI_PUBLICATION_FILTER_INVALID");
  expect(buildPublicationMetadataFilter([{ jurisdictionId: "legacy-healthy" }])).toBeUndefined();
});

it("copies validated metadata so caller mutation cannot alter the parsed allowlist", () => {
  const original = restriction(), parsed = parsePublicationFilter(original)!;
  original.documents[0].resourceId = "failed";
  original.documents.push(original.documents[0]);
  expect(parsed.documents).toHaveLength(1);
  expect(parsed.documents[0].resourceId).toBe("r0");
});

it("canonically binds the exact filter tuples and all stores while preserving healthy legacy proof shape", async () => {
  const published = restriction(2), restricted = { jurisdictionId: "ohada", storeName: "fileSearchStores/ohada", publicationFilter: published };
  const healthy = { jurisdictionId: "ghana", storeName: "fileSearchStores/ghana" };
  const binding = await createPublicationFilterBinding([restricted, healthy]);
  expect(binding).toMatch(/^[a-f0-9]{64}$/u);
  expect(await createPublicationFilterBinding([healthy, { ...restricted, publicationFilter: { ...published, documents: [...published.documents].reverse() } }])).toBe(binding);
  expect(await createPublicationFilterBinding([healthy])).toBeUndefined();
  for (const change of [
    { ...restricted, storeName: "fileSearchStores/replacement" },
    { ...restricted, publicationFilter: { ...published, environment: "development" } },
    { ...restricted, publicationFilter: { ...published, documents: [published.documents[0], { ...published.documents[1], sha256: "b".repeat(64) }] } },
    { ...restricted, publicationFilter: { ...published, documents: [published.documents[0], { ...published.documents[1], versionId: "replacement" }] } },
  ]) expect(await createPublicationFilterBinding([change, healthy])).not.toBe(binding);
  expect(await createPublicationFilterBinding([restricted, { ...healthy, jurisdictionId: "another" }])).not.toBe(binding);
});
