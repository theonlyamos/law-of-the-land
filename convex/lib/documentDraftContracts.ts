import { v } from "convex/values";
import { storedFindingCitationValidator } from "./documentReviewContracts";

export const documentDraftStatusValidator = v.union(
  v.literal("planning"), v.literal("awaiting_input"), v.literal("drafting"),
  v.literal("completed"), v.literal("failed"), v.literal("cancelled"),
);
export const clauseBasisValidator = v.union(v.literal("required"), v.literal("protects"), v.literal("common"), v.literal("choice"));
export const draftAudienceValidator = v.union(v.literal("personal"), v.literal("professional"));
export const documentDraftFailureValidator = v.union(
  v.literal("not_configured"), v.literal("provider"), v.literal("research_unavailable"), v.literal("timeout"),
  v.literal("cancelled"), v.literal("unreadable"), v.literal("too_large"), v.literal("internal"),
);
export const draftOptionValidator = v.object({ id: v.string(), label: v.string() });
export const draftQuestionValidator = v.object({
  id: v.string(),
  label: v.string(),
  help: v.optional(v.string()),
  kind: v.union(v.literal("text"), v.literal("longtext"), v.literal("date"), v.literal("number"), v.literal("choice")),
  options: v.array(v.string()),
  suggested: v.optional(v.string()),
});
export const draftAnswerValidator = v.object({ questionId: v.string(), label: v.string(), value: v.string() });
export const draftSectionValidator = v.object({
  heading: v.string(),
  purpose: v.string(),
  kind: v.union(v.literal("opening"), v.literal("clause"), v.literal("signatures"), v.literal("schedule")),
});

/** What planning returns, before the person answers the questions. */
export const draftPlanValidator = v.object({
  documentType: v.string(),
  title: v.string(),
  summary: v.string(),
  isLegalDocument: v.boolean(),
  roleOptions: v.array(draftOptionValidator),
  suggestedRoleId: v.optional(v.string()),
  suggestedAudience: draftAudienceValidator,
  questions: v.array(draftQuestionValidator),
  sections: v.array(draftSectionValidator),
  /** Facts taken from an attached file, for drafting. */
  sourceNotes: v.string(),
});

export const storedClauseCitationValidator = storedFindingCitationValidator;

export const proposedClauseCitationValidator = v.object({
  jurisdictionId: v.string(),
  resourceId: v.string(),
  versionId: v.string(),
  providerStoreName: v.string(),
  providerDocumentName: v.optional(v.string()),
  pageNumber: v.optional(v.number()),
  provision: v.optional(v.string()),
});

/** One clause written by the drafting model, before its citations are validated. */
export const proposedClauseValidator = v.object({
  sectionOrdinal: v.number(),
  heading: v.string(),
  text: v.string(),
  basis: clauseBasisValidator,
  why: v.string(),
  lawSummary: v.string(),
  provisions: v.array(v.string()),
  citations: v.array(proposedClauseCitationValidator),
});

export const proposedFormalityValidator = v.object({
  title: v.string(),
  detail: v.string(),
  basis: v.union(v.literal("required"), v.literal("common")),
  lawSummary: v.string(),
  provisions: v.array(v.string()),
  citations: v.array(proposedClauseCitationValidator),
});

export const storedFormalityValidator = v.object({
  title: v.string(),
  detail: v.string(),
  basis: v.union(v.literal("required"), v.literal("common")),
  citations: v.array(v.object({ label: v.string(), provision: v.optional(v.string()) })),
});
