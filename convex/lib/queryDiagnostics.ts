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
] as const;

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
});

export type QueryDiagnostics = Infer<typeof queryDiagnosticsValidator>;

const countFields = ["searchCallCount", "searchResultCount", "searchResultItemCount", "streamedAnnotationCount", "canonicalAnnotationCount"] as const;
const metadataFields = ["jurisdictionMetadataPresent", "resourceMetadataPresent", "versionMetadataPresent"] as const;
const allowedFields = new Set<string>([
  "version", "phase", "reason", ...countFields, "canonicalReadCompleted", "countsClamped", "citationUriKind", ...metadataFields,
]);
const reasons = new Set<string>(QUERY_DIAGNOSTIC_REASONS);

/** Rejects arbitrary provider content; diagnostics contain only closed labels and bounded counters. */
export function validateQueryDiagnostics(value: unknown): asserts value is QueryDiagnostics {
  const invalid = () => { throw new Error("INVALID_QUERY_DIAGNOSTICS"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const diagnostic = value as Record<string, unknown>;
  if (Object.keys(diagnostic).some(key => !allowedFields.has(key)) || diagnostic.version !== 1 ||
      !["generation", "canonical_read", "completion"].includes(diagnostic.phase as string) ||
      typeof diagnostic.reason !== "string" || !reasons.has(diagnostic.reason) ||
      countFields.some(key => !Number.isSafeInteger(diagnostic[key]) || (diagnostic[key] as number) < 0 || (diagnostic[key] as number) > 1024) ||
      typeof diagnostic.canonicalReadCompleted !== "boolean" || typeof diagnostic.countsClamped !== "boolean" ||
      (diagnostic.citationUriKind !== undefined && !["missing", "authorized_store", "authorized_document", "other"].includes(diagnostic.citationUriKind as string)) ||
      metadataFields.some(key => diagnostic[key] !== undefined && typeof diagnostic[key] !== "boolean")) invalid();
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
  ];
}
