import { v, type Infer } from "convex/values";

export const QUERY_DIAGNOSTIC_REASONS = [
  "unspecified", "canonical_state", "canonical_content", "canonical_block", "canonical_text",
  "canonical_annotations_limit", "canonical_answer", "citation_type", "citation_identity",
  "citation_offsets_missing", "citation_offsets_invalid", "citation_page", "selected_evidence_missing",
  "event_after_completion", "provider_error", "creation_state", "missing_interaction", "missing_stream_state",
  "status_update", "completion_state", "open_step", "step_index", "step_type", "duplicate_step",
  "file_search_call", "file_search_result", "step_stop", "event_type", "step_delta", "model_delta_type",
  "output_limit", "tool_delta_type", "incomplete_stream", "canonical_interaction", "canonical_text_mismatch",
  "policy_with_citations", "request_invalid", "response_invalid", "in_progress", "completed",
  "no_canonical_annotations", "deadline_exceeded", "aborted", "provider_request_failed",
  "completion_invalid", "research_unavailable", "not_configured",
  "file_search_call_id", "file_search_call_duplicate", "file_search_budget_exhausted",
  "stream_citation_batch", "stream_citation_limit", "stream_citation_ambiguous",
] as const;

export const QUERY_DIAGNOSTIC_ANNOTATION_KINDS = [
  "file_citation", "url_citation", "place_citation", "word_info", "speech_metadata", "missing_type", "unknown_type", "malformed",
] as const;
const resultDeltaKinds = ["missing", "empty_array", "nonempty_array", "other"] as const;
const uriKinds = ["missing", "authorized_store", "authorized_document", "other"] as const;
const uriKindValidator = v.union(...uriKinds.map(kind => v.literal(kind)));
const annotationCountsValidator = v.object({
  file_citation: v.number(), url_citation: v.number(), place_citation: v.number(), word_info: v.number(),
  speech_metadata: v.number(), missing_type: v.number(), unknown_type: v.number(), malformed: v.number(),
});
const annotationShapeValidator = v.object({
  kind: v.union(...QUERY_DIAGNOSTIC_ANNOTATION_KINDS.map(kind => v.literal(kind))),
  metadataContainer: v.union(v.literal("missing"), v.literal("object"), v.literal("array"), v.literal("other")),
  jurisdictionMetadataPresent: v.boolean(), resourceMetadataPresent: v.boolean(), versionMetadataPresent: v.boolean(),
  documentUriKind: uriKindValidator, fileNameKind: uriKindValidator,
  fileNamePresent: v.boolean(), sourcePresent: v.boolean(), duplicateIdentityMetadata: v.boolean(),
  offsetKind: v.union(v.literal("missing"), v.literal("valid_pair"), v.literal("invalid_pair"), v.literal("unpaired")),
  pageKind: v.union(v.literal("missing"), v.literal("valid"), v.literal("invalid")),
  offsetsWithinAnswer: v.optional(v.boolean()),
});
const annotationChannelValidator = v.object({
  annotationKinds: annotationCountsValidator, firstAnnotation: v.optional(annotationShapeValidator),
});
export const queryDiagnosticStructureValidator = v.object({
  stream: annotationChannelValidator, canonical: annotationChannelValidator, completion: annotationChannelValidator,
  completionStepsPresent: v.boolean(),
  fileSearchResultDeltas: v.object({ missing: v.number(), empty_array: v.number(), nonempty_array: v.number(), other: v.number() }),
  rejectedCanonicalAnnotation: v.optional(annotationShapeValidator),
  rejectedStreamAnnotation: v.optional(annotationShapeValidator),
});
export type QueryDiagnosticAnnotationKind = typeof QUERY_DIAGNOSTIC_ANNOTATION_KINDS[number];
export type QueryDiagnosticAnnotationCounts = Infer<typeof annotationCountsValidator>;
export type QueryDiagnosticAnnotationShape = Infer<typeof annotationShapeValidator>;
export type QueryDiagnosticStructure = Infer<typeof queryDiagnosticStructureValidator>;

const providerFailures = ["none", "timeout", "abort", "other"] as const;
const resumeOutcomes = ["not_attempted", "pending", "completed", "incomplete", "failed", "aborted"] as const;
export const queryDiagnosticExecutionValidator = v.object({
  modelDeadlineReached: v.boolean(), terminalDeadlineReached: v.boolean(),
  clientAbortObserved: v.boolean(), streamAbortObserved: v.boolean(),
  providerFailure: v.union(...providerFailures.map(value => v.literal(value))),
  completionEventAccepted: v.boolean(), streamClosed: v.boolean(), resumeAttempted: v.boolean(),
  resumeOutcome: v.union(...resumeOutcomes.map(value => v.literal(value))),
});
export type QueryDiagnosticExecution = Infer<typeof queryDiagnosticExecutionValidator>;

/** Private execution observations start unobserved and belong to one request. */
export function emptyQueryDiagnosticExecution(): QueryDiagnosticExecution {
  return {
    modelDeadlineReached: false, terminalDeadlineReached: false,
    clientAbortObserved: false, streamAbortObserved: false,
    providerFailure: "none", completionEventAccepted: false,
    streamClosed: false, resumeAttempted: false, resumeOutcome: "not_attempted",
  };
}

/** Every call owns its nested counters, so one request cannot mutate another observation. */
export function emptyQueryDiagnosticStructure(): QueryDiagnosticStructure {
  const channel = () => ({ annotationKinds: {
    file_citation: 0, url_citation: 0, place_citation: 0, word_info: 0,
    speech_metadata: 0, missing_type: 0, unknown_type: 0, malformed: 0,
  } });
  return { stream: channel(), canonical: channel(), completion: channel(), completionStepsPresent: false,
    fileSearchResultDeltas: { missing: 0, empty_array: 0, nonempty_array: 0, other: 0 } };
}

export const queryDiagnosticsValidator = v.object({
  version: v.literal(1),
  phase: v.union(v.literal("generation"), v.literal("canonical_read"), v.literal("completion")),
  reason: v.union(...QUERY_DIAGNOSTIC_REASONS.map(reason => v.literal(reason))),
  searchCallCount: v.number(), searchResultCount: v.number(), searchResultItemCount: v.number(),
  streamedAnnotationCount: v.number(), canonicalAnnotationCount: v.number(),
  canonicalReadCompleted: v.boolean(), countsClamped: v.boolean(),
  citationUriKind: v.optional(v.union(v.literal("missing"), v.literal("authorized_store"), v.literal("authorized_document"), v.literal("other"))),
  jurisdictionMetadataPresent: v.optional(v.boolean()),
  resourceMetadataPresent: v.optional(v.boolean()),
  versionMetadataPresent: v.optional(v.boolean()),
  structure: v.optional(queryDiagnosticStructureValidator),
  execution: v.optional(queryDiagnosticExecutionValidator),
});

export type QueryDiagnostics = Infer<typeof queryDiagnosticsValidator>;

const countFields = ["searchCallCount", "searchResultCount", "searchResultItemCount", "streamedAnnotationCount", "canonicalAnnotationCount"] as const;
const metadataFields = ["jurisdictionMetadataPresent", "resourceMetadataPresent", "versionMetadataPresent"] as const;
const allowedFields = new Set<string>([
  "version", "phase", "reason", ...countFields, "canonicalReadCompleted", "countsClamped", "citationUriKind", ...metadataFields, "structure", "execution",
]);
const reasons = new Set<string>(QUERY_DIAGNOSTIC_REASONS);

function invalid(): never { throw new Error("INVALID_QUERY_DIAGNOSTICS"); }

function closedRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (required.some(key => !Object.prototype.hasOwnProperty.call(record, key)) || Object.keys(record).some(key => !required.includes(key) && !optional.includes(key))) invalid();
  return record;
}

function validCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1024;
}

const shapeBooleanFields = [...metadataFields, "fileNamePresent", "sourcePresent", "duplicateIdentityMetadata"] as const;
function validateAnnotationShape(value: unknown): void {
  const shape = closedRecord(value, ["kind", "metadataContainer", "documentUriKind", "fileNameKind", "offsetKind", "pageKind", ...shapeBooleanFields], ["offsetsWithinAnswer"]);
  if (!QUERY_DIAGNOSTIC_ANNOTATION_KINDS.includes(shape.kind as QueryDiagnosticAnnotationKind) ||
      !["missing", "object", "array", "other"].includes(shape.metadataContainer as string) ||
      !uriKinds.includes(shape.documentUriKind as typeof uriKinds[number]) ||
      !uriKinds.includes(shape.fileNameKind as typeof uriKinds[number]) ||
      !["missing", "valid_pair", "invalid_pair", "unpaired"].includes(shape.offsetKind as string) ||
      !["missing", "valid", "invalid"].includes(shape.pageKind as string) ||
      (shape.offsetsWithinAnswer !== undefined && typeof shape.offsetsWithinAnswer !== "boolean") ||
      shapeBooleanFields.some(key => typeof shape[key] !== "boolean")) invalid();
}

function validateStructure(value: unknown): void {
  const structure = closedRecord(value, ["stream", "canonical", "completion", "completionStepsPresent", "fileSearchResultDeltas"], ["rejectedCanonicalAnnotation", "rejectedStreamAnnotation"]);
  if (typeof structure.completionStepsPresent !== "boolean") invalid();
  for (const key of ["stream", "canonical", "completion"]) {
    const channel = closedRecord(structure[key], ["annotationKinds"], ["firstAnnotation"]);
    const counts = closedRecord(channel.annotationKinds, QUERY_DIAGNOSTIC_ANNOTATION_KINDS);
    if (QUERY_DIAGNOSTIC_ANNOTATION_KINDS.some(kind => !validCount(counts[kind]))) invalid();
    if (channel.firstAnnotation !== undefined) validateAnnotationShape(channel.firstAnnotation);
  }
  const deltas = closedRecord(structure.fileSearchResultDeltas, resultDeltaKinds);
  if (resultDeltaKinds.some(kind => !validCount(deltas[kind]))) invalid();
  if (structure.rejectedCanonicalAnnotation !== undefined) validateAnnotationShape(structure.rejectedCanonicalAnnotation);
  if (structure.rejectedStreamAnnotation !== undefined) validateAnnotationShape(structure.rejectedStreamAnnotation);
}

const executionBooleanFields = [
  "modelDeadlineReached", "terminalDeadlineReached", "clientAbortObserved", "streamAbortObserved",
  "completionEventAccepted", "streamClosed", "resumeAttempted",
] as const;
function validateExecution(value: unknown): void {
  const execution = closedRecord(value, [...executionBooleanFields, "providerFailure", "resumeOutcome"]);
  if (executionBooleanFields.some(key => typeof execution[key] !== "boolean") ||
      !providerFailures.includes(execution.providerFailure as typeof providerFailures[number]) ||
      !resumeOutcomes.includes(execution.resumeOutcome as typeof resumeOutcomes[number])) invalid();
}

/** Rejects arbitrary provider content; diagnostics contain only closed labels and bounded counters. */
export function validateQueryDiagnostics(value: unknown): asserts value is QueryDiagnostics {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const diagnostic = value as Record<string, unknown>;
  if (Object.keys(diagnostic).some(key => !allowedFields.has(key)) || diagnostic.version !== 1 ||
      !["generation", "canonical_read", "completion"].includes(diagnostic.phase as string) ||
      typeof diagnostic.reason !== "string" || !reasons.has(diagnostic.reason) ||
      countFields.some(key => !validCount(diagnostic[key])) ||
      typeof diagnostic.canonicalReadCompleted !== "boolean" || typeof diagnostic.countsClamped !== "boolean" ||
      (diagnostic.citationUriKind !== undefined && !["missing", "authorized_store", "authorized_document", "other"].includes(diagnostic.citationUriKind as string)) ||
      metadataFields.some(key => diagnostic[key] !== undefined && typeof diagnostic[key] !== "boolean")) invalid();
  if (diagnostic.structure !== undefined) validateStructure(diagnostic.structure);
  if (diagnostic.execution !== undefined) validateExecution(diagnostic.execution);
}

function annotationShapeProofParts(shape?: QueryDiagnosticAnnotationShape): readonly (string | number)[] {
  if (shape === undefined) return [0];
  return [1, shape.kind, shape.metadataContainer, shape.documentUriKind, shape.fileNameKind,
    ...shapeBooleanFields.map(key => shape[key] ? 1 : 0), shape.offsetKind, shape.pageKind,
    shape.offsetsWithinAnswer === undefined ? -1 : shape.offsetsWithinAnswer ? 1 : 0];
}

function structureProofParts(structure?: QueryDiagnosticStructure): readonly (string | number)[] {
  if (structure === undefined) return [];
  return ["query-diagnostics-structure-v1", ...(["stream", "canonical", "completion"] as const).flatMap(key => [
    ...QUERY_DIAGNOSTIC_ANNOTATION_KINDS.map(kind => structure[key].annotationKinds[kind]),
    ...annotationShapeProofParts(structure[key].firstAnnotation),
  ]), structure.completionStepsPresent ? 1 : 0, ...resultDeltaKinds.map(kind => structure.fileSearchResultDeltas[kind]),
  ...annotationShapeProofParts(structure.rejectedCanonicalAnnotation),
  ...(structure.rejectedStreamAnnotation === undefined ? [] : [
    "query-diagnostics-stream-rejection-v1", ...annotationShapeProofParts(structure.rejectedStreamAnnotation),
  ])];
}

function executionProofParts(execution?: QueryDiagnosticExecution): readonly (string | number)[] {
  if (execution === undefined) return [];
  return ["query-diagnostics-execution-v1",
    execution.modelDeadlineReached ? 1 : 0, execution.terminalDeadlineReached ? 1 : 0,
    execution.clientAbortObserved ? 1 : 0, execution.streamAbortObserved ? 1 : 0,
    execution.providerFailure, execution.completionEventAccepted ? 1 : 0,
    execution.streamClosed ? 1 : 0, execution.resumeAttempted ? 1 : 0, execution.resumeOutcome];
}

/** An absent field adds no parts, preserving completion proofs from older route deployments. */
export function queryDiagnosticsProofParts(diagnostics?: QueryDiagnostics): readonly (string | number)[] {
  if (diagnostics === undefined) return [];
  validateQueryDiagnostics(diagnostics);
  const optionalBoolean = (value: boolean | undefined) => value === undefined ? -1 : value ? 1 : 0;
  return [
    "query-diagnostics-v1", diagnostics.phase, diagnostics.reason,
    diagnostics.searchCallCount, diagnostics.searchResultCount, diagnostics.searchResultItemCount,
    diagnostics.streamedAnnotationCount, diagnostics.canonicalAnnotationCount,
    diagnostics.canonicalReadCompleted ? 1 : 0, diagnostics.countsClamped ? 1 : 0,
    diagnostics.citationUriKind ?? "",
    optionalBoolean(diagnostics.jurisdictionMetadataPresent), optionalBoolean(diagnostics.resourceMetadataPresent),
    optionalBoolean(diagnostics.versionMetadataPresent),
    ...structureProofParts(diagnostics.structure),
    ...executionProofParts(diagnostics.execution),
  ];
}
