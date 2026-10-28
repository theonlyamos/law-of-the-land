/** Shared contracts for reviewing an uploaded legal document against the law library. */

export const DOCUMENT_REVIEW_LIMITS = {
  /** Passages read from one document. Longer documents keep their key passages. */
  maxSegments: 80,
  maxSegmentCharacters: 2_400,
  /** Passages checked against the law in one review. */
  maxCheckedSegments: 40,
  /** Passages sent to the model in one checking request. */
  checkBatchSize: 5,
  /** Checking requests running at the same time. */
  checkConcurrency: 3,
  maxFindings: 60,
  maxGapFindings: 6,
  maxCitationsPerFinding: 4,
  maxRoleOptions: 4,
  maxFocusOptions: 8,
  maxSelectedFocus: 8,
  maxQuestionCharacters: 4_000,
  maxShortText: 160,
  maxText: 1_600,
  maxReviewsPerChat: 20,
} as const;

export const DOCUMENT_REVIEW_STATUSES = ["reading", "awaiting_input", "checking", "completed", "failed", "cancelled"] as const;
export type DocumentReviewStatus = (typeof DOCUMENT_REVIEW_STATUSES)[number];

export const FINDING_STATUSES = ["attention", "check", "fine", "unconfirmed"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const FINDING_STATUS_LABELS: Record<FindingStatus, string> = {
  attention: "Needs attention",
  check: "Worth checking",
  fine: "Looks fine",
  unconfirmed: "Couldn't confirm",
};

export const FINDING_STATUS_DESCRIPTIONS: Record<FindingStatus, string> = {
  attention: "Conflicts with the law or gives you less than the law requires.",
  check: "Unclear, unusual or one-sided. Worth asking about.",
  fine: "Matches the law in the library.",
  unconfirmed: "The library doesn't cover this, or we couldn't link it to a specific source.",
};

/** Most serious first. */
export const FINDING_STATUS_ORDER: Record<FindingStatus, number> = { attention: 0, check: 1, unconfirmed: 2, fine: 3 };

export const DOCUMENT_REVIEW_FAILURES = [
  "unreadable", "too_large", "not_configured", "provider", "research_unavailable", "timeout", "cancelled", "internal",
] as const;
export type DocumentReviewFailure = (typeof DOCUMENT_REVIEW_FAILURES)[number];

export const DOCUMENT_REVIEW_FAILURE_MESSAGES: Record<DocumentReviewFailure, string> = {
  unreadable: "We couldn't read this document. Upload a clearer copy or a text version and try again.",
  too_large: "This document is too long to review in one go. Upload the part you want checked.",
  not_configured: "Document review isn't available right now. Please try again later.",
  provider: "The review service didn't respond properly. Please try again.",
  research_unavailable: "The law library for this jurisdiction isn't available right now. Please try again later.",
  timeout: "The review took too long to finish. Please try again.",
  cancelled: "You stopped this review.",
  internal: "Something went wrong while reviewing this document. Please try again.",
};

export type DocumentReviewOption = { id: string; label: string };

export type DocumentReviewCitation = {
  label: string;
  provision?: string;
  jurisdictionName: string;
  jurisdictionKind: "geographic" | "organizational";
  relation: "selected" | "geographic_ancestor" | "organizational_geography";
  pageNumber?: number;
  /** Whether the original PDF can be opened from the review. */
  previewable: boolean;
};

export type DocumentReviewFinding = {
  id: string;
  ordinal: number;
  /** The passage this finding is about. Absent for something missing from the document. */
  segmentOrdinal?: number;
  kind: "passage" | "missing";
  status: FindingStatus;
  title: string;
  meaning: string;
  lawSummary: string;
  recommendation: string;
  suggestedWording?: string;
  citations: DocumentReviewCitation[];
};

export type DocumentReviewSegment = {
  ordinal: number;
  ref?: string;
  heading?: string;
  text: string;
  page?: number;
  excerpt: boolean;
  checked: boolean;
};

export type DocumentReviewCounts = Record<FindingStatus, number>;

export function emptyCounts(): DocumentReviewCounts {
  return { attention: 0, check: 0, fine: 0, unconfirmed: 0 };
}

export function countFindings(findings: readonly Pick<DocumentReviewFinding, "status">[]): DocumentReviewCounts {
  const counts = emptyCounts();
  for (const finding of findings) counts[finding.status] += 1;
  return counts;
}

export function sortFindings<T extends Pick<DocumentReviewFinding, "status" | "ordinal" | "segmentOrdinal">>(findings: readonly T[], order: "severity" | "document" = "severity"): T[] {
  return [...findings].sort((left, right) => order === "severity"
    ? FINDING_STATUS_ORDER[left.status] - FINDING_STATUS_ORDER[right.status] || documentPosition(left) - documentPosition(right)
    : documentPosition(left) - documentPosition(right) || FINDING_STATUS_ORDER[left.status] - FINDING_STATUS_ORDER[right.status]);
}

function documentPosition(finding: Pick<DocumentReviewFinding, "ordinal" | "segmentOrdinal">): number {
  // Missing terms sort after the passages, in the order they were found.
  return finding.segmentOrdinal === undefined ? 1_000_000 + finding.ordinal : finding.segmentOrdinal * 1_000 + finding.ordinal;
}

/** A stable, bounded identifier for a model-proposed option. */
export function optionId(label: string): string {
  return label.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40) || "option";
}

export const NOT_SURE_ROLE: DocumentReviewOption = { id: "not-sure", label: "Neither / not sure" };

function normalized(query: string): string {
  return query.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

const DOCUMENT_NOUN = String.raw`(?:documents?|files?|contracts?|agreements?|leases?|tenancy|tenancy agreements?|letters?|notices?|forms?|wills?|deeds?|polic(?:y|ies)|terms|conditions|t&cs|offer(?: letter)?|nda|mou|memorandum|bylaws|constitution|summons|judg(?:e)?ments?|orders?|claims?|invoices?|receipts?|certificates?|pdfs?|attachments?|draft|clauses?|paperwork|this|it|these|them)`;
const REVIEW_VERB = String.raw`(?:review|check|vet|audit|assess|evaluate|analy[sz]e|scrutini[sz]e|examine|inspect|critique|proofread|look (?:over|through|into|at)|go (?:over|through)|read (?:over|through)|run through)`;
const PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\b${REVIEW_VERB}\b(?:\s+\w+){0,4}?\s+${DOCUMENT_NOUN}\b`, "u"),
  new RegExp(String.raw`^${REVIEW_VERB}$`, "u"),
  /\b(?:before|should|can|is it safe to|safe to|ok to|okay to) (?:i |we )?sign\b/u,
  /\b(?:sign|signing) (?:this|it|the)\b/u,
  /\bred flags?\b/u,
  /\b(?:anything|something|what(?:'s| is)?) (?:wrong|unusual|unfair|illegal|unlawful|missing|dodgy|suspicious|problematic|concerning|off)\b/u,
  /\b(?:watch|look) out for\b/u,
  /\b(?:problems?|issues?|risks?|loopholes?|traps?|concerns?) (?:with|in) (?:this|the|my|it)\b/u,
  /\bis (?:this|the|my|it|that)\b(?:\s+[\w'-]+){0,4}\s+(?:legal|lawful|valid|enforceable|binding|fair|standard|compliant|reasonable|void|illegal|unlawful|unfair|legit|legitimate|okay|ok|correct|proper)\b/u,
  /\b(?:does|do|will) (?:this|it|the|my)(?:\s+[\w'-]+){0,3}?\s+(?:comply|hold up|stand up|meet)\b/u,
  /\b(?:compl(?:y|ies|iant)|in line) with (?:the )?(?:[\w'-]+\s+){0,4}?(?:law|act|regulations?|rules|code)\b/u,
  /\bmy rights under (?:this|the|it)\b/u,
  /\b(?:what|which) (?:clauses?|terms?|parts?|sections?) (?:should|need|are)\b/u,
];

const NOT_A_REVIEW = /^(?:(?:can|could|would) you )?(?:please )?(?:summari[sz]e|transcribe|translate|describe|extract|list|read out)\b/u;

/**
 * Whether a question about attached files asks for the document itself to be
 * evaluated against the law. Specific legal questions keep the ordinary answer path.
 */
export function isDocumentReviewRequest(query: string): boolean {
  const text = normalized(query);
  if (!text || text.length > DOCUMENT_REVIEW_LIMITS.maxQuestionCharacters) return false;
  if (NOT_A_REVIEW.test(text)) return false;
  return PATTERNS.some((pattern) => pattern.test(text));
}

export const DEFAULT_REVIEW_QUESTION = "Review this document against the law.";

export function reviewProgressLabel(review: { status: DocumentReviewStatus; checked: number; total: number }): string {
  switch (review.status) {
    case "reading": return "Reading your document…";
    case "awaiting_input": return "Ready to review";
    case "checking": return review.total
      ? `Checking against the law · ${Math.min(review.checked, review.total)} of ${review.total}`
      : "Checking against the law…";
    case "completed": return "Review complete";
    case "failed": return "Review didn't finish";
    case "cancelled": return "Review stopped";
  }
}

/** Signed by the Next.js source route so a review source opens only through it. */
export function documentReviewSourceProofParts(input: { reviewId: string; findingId: string; citationIndex: number; expiresAt: number }): readonly (string | number)[] {
  return ["document-review-source-file-v1", input.reviewId, input.findingId, input.citationIndex, input.expiresAt];
}

export function documentReviewSourceUrl(reviewId: string, findingId: string, citationIndex: number, pageNumber?: number): string {
  return `/api/document-reviews/${encodeURIComponent(reviewId)}/sources/${encodeURIComponent(findingId)}/${citationIndex}${pageNumber ? `#page=${pageNumber}` : ""}`;
}
