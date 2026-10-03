import { describe, expect, it } from "vitest";
import { emptyQueryDiagnosticStructure, queryDiagnosticsProofParts, validateQueryDiagnostics, type QueryDiagnosticAnnotationShape, type QueryDiagnosticStructure } from "./queryDiagnostics";

const base = {
  version: 1 as const, phase: "canonical_read" as const, reason: "citation_type" as const,
  searchCallCount: 1, searchResultCount: 2, searchResultItemCount: 3,
  streamedAnnotationCount: 4, canonicalAnnotationCount: 5,
  canonicalReadCompleted: true, countsClamped: false,
};

function shape(): QueryDiagnosticAnnotationShape {
  return {
    kind: "file_citation", metadataContainer: "array", jurisdictionMetadataPresent: true,
    resourceMetadataPresent: true, versionMetadataPresent: true,
    documentUriKind: "missing", fileNameKind: "authorized_document",
    fileNamePresent: true, sourcePresent: false, duplicateIdentityMetadata: false,
    offsetKind: "valid_pair", pageKind: "valid", offsetsWithinAnswer: true,
  };
}

function structure(): QueryDiagnosticStructure {
  const channel = () => ({ annotationKinds: {
    file_citation: 1, url_citation: 0, place_citation: 0, word_info: 0,
    speech_metadata: 0, missing_type: 0, unknown_type: 0, malformed: 0,
  }, firstAnnotation: shape() });
  return {
    stream: channel(), canonical: channel(), completion: channel(),
    completionStepsPresent: true,
    fileSearchResultDeltas: { missing: 0, empty_array: 1, nonempty_array: 2, other: 0 },
    rejectedCanonicalAnnotation: shape(),
  };
}

describe("structural query diagnostics", () => {
  it("preserves the exact old v1 proof when the extension is absent", () => {
    expect(queryDiagnosticsProofParts(base)).toEqual([
      "query-diagnostics-v1", "canonical_read", "citation_type", 1, 2, 3, 4, 5, 1, 0, "", -1, -1, -1,
    ]);
  });

  it("accepts bounded structural categories and appends a separate versioned proof", () => {
    const diagnostic = { ...base, structure: structure() };
    expect(() => validateQueryDiagnostics(diagnostic)).not.toThrow();
    validateQueryDiagnostics(diagnostic);
    const parts = queryDiagnosticsProofParts(diagnostic);
    expect(parts.slice(0, 14)).toEqual(queryDiagnosticsProofParts(base));
    expect(parts[14]).toBe("query-diagnostics-structure-v1");
    expect(JSON.stringify(parts)).not.toMatch(/fileSearchStores\/|private-provider-value/);
  });

  it("returns fresh empty counters for every channel and request", () => {
    const first = emptyQueryDiagnosticStructure();
    const second = emptyQueryDiagnosticStructure();
    first.stream.annotationKinds.file_citation = 1;
    first.fileSearchResultDeltas.missing = 2;
    expect(first.canonical.annotationKinds.file_citation).toBe(0);
    expect(second.stream.annotationKinds.file_citation).toBe(0);
    expect(second.fileSearchResultDeltas.missing).toBe(0);
    expect(() => validateQueryDiagnostics({ ...base, structure: second })).not.toThrow();
  });

  it.each([
    ["stream", "annotationKinds", "file_citation", -1], ["canonical", "annotationKinds", "url_citation", 1025],
    ["completion", "annotationKinds", "unknown_type", 0.5], ["completion", "annotationKinds", "malformed", Number.NaN],
    ["stream", "annotationKinds", "raw_type", 1], ["canonical", "firstAnnotation", "kind", "private-provider-type"],
    ["canonical", "firstAnnotation", "documentUriKind", "fileSearchStores/private/documents/private"],
    ["canonical", "firstAnnotation", "rawUri", "fileSearchStores/private/documents/private"],
    ["completion", "firstAnnotation", "metadataContainer", "private-value"], ["completion", "firstAnnotation", "payload", "private-provider-value"],
    ["stream", "firstAnnotation", "duplicateIdentityMetadata", "true"], ["canonical", "firstAnnotation", "offsetKind", 0],
    ["canonical", "firstAnnotation", "pageKind", 1], ["canonical", "firstAnnotation", "offsetsWithinAnswer", 1],
  ])("rejects nested field %s.%s.%s with invalid or raw values", (channel, container, field, value) => {
    const diagnostic = { ...base, structure: structure() };
    const record = diagnostic.structure as unknown as Record<string, Record<string, Record<string, unknown>>>;
    record[String(channel)][String(container)][String(field)] = value;
    expect(() => validateQueryDiagnostics(diagnostic)).toThrow("INVALID_QUERY_DIAGNOSTICS");
  });

  it.each([
    ["missing", -1], ["empty_array", 1025], ["nonempty_array", 0.1], ["other", Number.POSITIVE_INFINITY], ["rawPayload", "private-provider-value"],
  ])("rejects invalid result-delta counter %s", (field, value) => {
    const diagnostic = { ...base, structure: structure() };
    (diagnostic.structure.fileSearchResultDeltas as Record<string, unknown>)[String(field)] = value;
    expect(() => validateQueryDiagnostics(diagnostic)).toThrow("INVALID_QUERY_DIAGNOSTICS");
  });

  it.each(["stream", "canonical", "completion", "fileSearchResultDeltas", "completionStepsPresent"])("requires structural field %s", field => {
    const diagnostic = { ...base, structure: structure() };
    delete (diagnostic.structure as unknown as Record<string, unknown>)[field];
    expect(() => validateQueryDiagnostics(diagnostic)).toThrow("INVALID_QUERY_DIAGNOSTICS");
  });

  it("rejects raw values on the rejected shape and unknown structural keys", () => {
    const rejected = structure();
    (rejected.rejectedCanonicalAnnotation as unknown as Record<string, unknown>).source = "private-provider-value";
    expect(() => validateQueryDiagnostics({ ...base, structure: rejected })).toThrow("INVALID_QUERY_DIAGNOSTICS");
    expect(() => validateQueryDiagnostics({ ...base, structure: { ...structure(), payload: "private-provider-value" } })).toThrow("INVALID_QUERY_DIAGNOSTICS");
  });

  it.each([0, 1024])("accepts count boundary %s for every nested counter", count => {
    const diagnostic = { ...base, structure: structure() };
    for (const channel of [diagnostic.structure.stream, diagnostic.structure.canonical, diagnostic.structure.completion]) {
      for (const kind of Object.keys(channel.annotationKinds)) (channel.annotationKinds as Record<string, number>)[kind] = count;
    }
    for (const kind of Object.keys(diagnostic.structure.fileSearchResultDeltas)) (diagnostic.structure.fileSearchResultDeltas as Record<string, number>)[kind] = count;
    expect(() => validateQueryDiagnostics(diagnostic)).not.toThrow();
  });

  it("binds every shape field and preserves key-order independence", () => {
    const original = { ...base, structure: structure() };
    const proof = queryDiagnosticsProofParts(original);
    const variants: Array<Partial<QueryDiagnosticAnnotationShape>> = [
      { kind: "url_citation" }, { metadataContainer: "object" }, { jurisdictionMetadataPresent: false },
      { resourceMetadataPresent: false }, { versionMetadataPresent: false }, { documentUriKind: "other" },
      { fileNameKind: "other" }, { fileNamePresent: false }, { sourcePresent: true }, { duplicateIdentityMetadata: true },
      { offsetKind: "unpaired" }, { pageKind: "invalid" }, { offsetsWithinAnswer: false }, { offsetsWithinAnswer: undefined },
    ];
    for (const change of variants) {
      const modified = structure();
      modified.canonical.firstAnnotation = { ...shape(), ...change };
      expect(queryDiagnosticsProofParts({ ...base, structure: modified })).not.toEqual(proof);
    }
    const reordered = structure();
    reordered.canonical.firstAnnotation = Object.fromEntries(Object.entries(shape()).reverse()) as QueryDiagnosticAnnotationShape;
    expect(queryDiagnosticsProofParts({ ...base, structure: reordered })).toEqual(proof);
  });
});
