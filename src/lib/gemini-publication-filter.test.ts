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

it("never silently truncates an allowlist or omits an oversized aggregate filter", () => {
  expect(() => buildPublicationMetadataFilter([{ jurisdictionId: "ohada", publicationFilter: restriction(65) }])).toThrow("GEMINI_PUBLICATION_FILTER_INVALID");
  expect(() => buildPublicationMetadataFilter([{ jurisdictionId: "ohada", publicationFilter: restriction(33) },
    { jurisdictionId: "another", publicationFilter: restriction(32) }])).toThrow("GEMINI_PUBLICATION_FILTER_INVALID");
  const wide = restriction(64, 63);
  expect(parsePublicationFilter(wide)).not.toBeNull();
  expect(wide.documents.every(document => document.resourceId.length === 64)).toBe(true);
  // Additional branches still cannot exceed the aggregate byte ceiling. The
  // provider separately imposes the existing four-store request limit.
  expect(() => buildPublicationMetadataFilter([{ jurisdictionId: "ohada", publicationFilter: wide },
    ...Array.from({ length: 100 }, (_, index) => ({ jurisdictionId: `j${String(index).padStart(63, "0")}` })),
  ])).toThrow("GEMINI_PUBLICATION_FILTER_INVALID");
  expect(MAX_PUBLICATION_FILTER_BYTES).toBe(16_384);
  expect(buildPublicationMetadataFilter([{ jurisdictionId: "ohada", publicationFilter: restriction(18) }])!.length).toBeLessThan(MAX_PUBLICATION_FILTER_BYTES);
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
