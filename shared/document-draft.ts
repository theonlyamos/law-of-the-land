/** Shared contracts for drafting a legal document from the law library. */

export const DOCUMENT_DRAFT_LIMITS = {
  maxRequestCharacters: 4_000,
  /** Sections planned for one document, including the opening and signatures. */
  maxSections: 40,
  maxQuestions: 10,
  maxQuestionOptions: 6,
  maxAnswerCharacters: 1_000,
  maxRoleOptions: 4,
  maxClauseCharacters: 6_000,
  maxClauseHeading: 120,
  maxInstructionCharacters: 1_000,
  /** Sections drafted in one grounded request. Small batches leave room to search for each. */
  draftBatchSize: 3,
  /** Drafting requests running at the same time. */
  draftConcurrency: 4,
  maxFormalities: 8,
  maxCitationsPerClause: 4,
  maxDraftsPerChat: 20,
  maxShortText: 160,
  maxText: 1_600,
} as const;

export const DOCUMENT_DRAFT_STATUSES = ["planning", "awaiting_input", "drafting", "completed", "failed", "cancelled"] as const;
export type DocumentDraftStatus = (typeof DOCUMENT_DRAFT_STATUSES)[number];

/** Why a clause is in the document. */
export const CLAUSE_BASES = ["required", "protects", "common", "choice"] as const;
export type ClauseBasis = (typeof CLAUSE_BASES)[number];

export const CLAUSE_BASIS_LABELS: Record<ClauseBasis, string> = {
  required: "Required by law",
  protects: "Backed by law",
  common: "No law cited",
  choice: "Your choice",
};

export const CLAUSE_BASIS_DESCRIPTIONS: Record<ClauseBasis, string> = {
  required: "The law requires this term, or limits what it can say.",
  protects: "A provision in the library supports or shapes this term.",
  common: "No provision in the library deals with this term directly. Terms like this are usually left to what the parties agree.",
  choice: "Wording that records the details and choices you gave.",
};

/** Who the draft is written for, which sets its drafting style. */
export const DRAFT_AUDIENCES = ["personal", "professional"] as const;
export type DraftAudience = (typeof DRAFT_AUDIENCES)[number];

export const DRAFT_AUDIENCE_LABELS: Record<DraftAudience, string> = {
  personal: "Me or my business",
  professional: "A legal professional",
};

export const DOCUMENT_DRAFT_FAILURES = [
  "not_configured", "provider", "research_unavailable", "timeout", "cancelled", "unreadable", "too_large", "internal",
] as const;
export type DocumentDraftFailure = (typeof DOCUMENT_DRAFT_FAILURES)[number];

export const DOCUMENT_DRAFT_FAILURE_MESSAGES: Record<DocumentDraftFailure, string> = {
  not_configured: "Document drafting isn't available right now. Please try again later.",
  provider: "The drafting service didn't respond properly. Please try again.",
  research_unavailable: "The law library for this jurisdiction isn't available right now. Please try again later.",
  timeout: "Drafting took too long to finish. Please try again.",
  cancelled: "You stopped this draft.",
  unreadable: "We couldn't read the attached file. Upload a clearer copy or a text version and try again.",
  too_large: "The attached file is too long to use. Upload the part that matters for this document.",
  internal: "Something went wrong while drafting this document. Please try again.",
};

export const DRAFT_QUESTION_KINDS = ["text", "longtext", "date", "number", "choice"] as const;
export type DraftQuestionKind = (typeof DRAFT_QUESTION_KINDS)[number];

export type DraftQuestion = {
  id: string;
  label: string;
  help?: string;
  kind: DraftQuestionKind;
  options: string[];
  /** A value taken from the request, shown pre-filled. */
  suggested?: string;
};

export type DraftOption = { id: string; label: string };

export type DraftCitation = {
  label: string;
  provision?: string;
  jurisdictionName: string;
  jurisdictionKind: "geographic" | "organizational";
  relation: "selected" | "geographic_ancestor" | "organizational_geography";
  pageNumber?: number;
  previewable: boolean;
};

export type DraftClause = {
  ordinal: number;
  heading: string;
  text: string;
  basis: ClauseBasis;
  why: string;
  lawSummary: string;
  citations: DraftCitation[];
  edited: boolean;
};

export type DraftFormality = {
  title: string;
  detail: string;
  basis: "required" | "common";
  citations: { label: string; provision?: string }[];
};

export const NOT_SURE_SIDE: DraftOption = { id: "neutral", label: "Neutral, for both sides" };

/** A stable, bounded identifier for a model-proposed option or question. */
export function draftOptionId(label: string): string {
  return label.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40) || "option";
}

/** Blanks left in a draft, written as [Tenant's full name]. */
export const PLACEHOLDER_PATTERN = /\[[^[\]\n]{2,80}\]/gu;

export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[0]);
}

export function countPlaceholders(texts: readonly string[]): number {
  return texts.reduce((total, text) => total + placeholdersIn(text).length, 0);
}

export function countBases(clauses: readonly Pick<DraftClause, "basis">[]): Record<ClauseBasis, number> {
  const counts: Record<ClauseBasis, number> = { required: 0, protects: 0, common: 0, choice: 0 };
  for (const clause of clauses) counts[clause.basis] += 1;
  return counts;
}

function normalized(query: string): string {
  return query.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

const DRAFT_VERB = String.raw`(?:draft|write|prepare|create|generate|produce|make|compose|put together|draw up|set up|type up)`;
const DOCUMENT_NOUN = String.raw`(?:agreements?|contracts?|leases?|tenancy(?: agreement)?|letters?|notices?|wills?|deeds?|polic(?:y|ies)|terms(?: and conditions| of service| of use)?|t&cs|nda|mou|memorand(?:um|a)|bylaws|constitution|resolutions?|affidavits?|declarations?|statutory declaration|power of attorney|waivers?|releases?|consents?|petitions?|motions?|pleadings?|summons|complaints?|claims?|demand|invoices?|receipts?|undertakings?|guarantees?|indentures?|conveyances?|assignments?|licen[cs]es?|warrant(?:y|ies)|certificates?|forms?|documents?|clauses?|schedules?|addend(?:um|a)|amendments?|minutes|offer(?: letter)?|appointment letter|dismissal letter|resignation letter|eviction notice|notice to quit|statement of claim|privacy notice|privacy policy|handbook|code of conduct|partnership agreement|shareholders?'? agreement|articles of association)`;
const PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\b${DRAFT_VERB}\b(?:\s+[\w'&-]+){0,6}?\s+${DOCUMENT_NOUN}\b`, "u"),
  new RegExp(String.raw`\b(?:i|we) need (?:a|an|the|some)\s+(?:[\w'&-]+\s+){0,5}?${DOCUMENT_NOUN}\b`, "u"),
  new RegExp(String.raw`\b(?:template|precedent|sample|boilerplate) (?:for|of) (?:a|an|the)?\s*(?:[\w'&-]+\s+){0,5}?${DOCUMENT_NOUN}\b`, "u"),
];
const NOT_A_DRAFT = /^(?:(?:can|could|would) you )?(?:please )?(?:review|check|summari[sz]e|explain|translate|what|why|when|who|is|are|does|do)\b/u;

/** Whether a message asks for a new legal document to be written. */
export function isDocumentDraftRequest(query: string): boolean {
  const text = normalized(query);
  if (!text || text.length > DOCUMENT_DRAFT_LIMITS.maxRequestCharacters) return false;
  if (NOT_A_DRAFT.test(text)) return false;
  return PATTERNS.some((pattern) => pattern.test(text));
}

export const DEFAULT_DRAFT_REQUEST = "Draft a legal document for me.";

/** Signed by the Next.js source route so a draft source opens only through it. */
export function documentDraftSourceProofParts(input: { draftId: string; clauseId: string; citationIndex: number; expiresAt: number }): readonly (string | number)[] {
  return ["document-draft-source-file-v1", input.draftId, input.clauseId, input.citationIndex, input.expiresAt];
}

export function documentDraftSourceUrl(draftId: string, clauseId: string, citationIndex: number, pageNumber?: number): string {
  return `/api/document-drafts/${encodeURIComponent(draftId)}/sources/${encodeURIComponent(clauseId)}/${citationIndex}${pageNumber ? `#page=${pageNumber}` : ""}`;
}

/** "tenancy agreement.docx" style file name, without characters file systems reject. */
export function draftFileName(title: string, extension: "docx" | "pdf"): string {
  const base = title.normalize("NFKC").replace(/[\\/:*?"<>|\u0000-\u001f]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 80) || "Document";
  return `${base}.${extension}`;
}
