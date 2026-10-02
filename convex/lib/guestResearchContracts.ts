import { v, type Infer } from "convex/values";
import { chatCitationValidator, jurisdictionKindValidator } from "./jurisdictionDomain";
import { widgetErrorCodeValidator, widgetTurnStateValidator } from "./widgetContracts";

export const GUEST_RESEARCH_LIMIT = 2;
export const GUEST_RESEARCH_LIFETIME_MS = 24 * 60 * 60_000;
export const guestErrorValidator = v.object({
  code: v.union(widgetErrorCodeValidator, v.literal("TRIAL_EXHAUSTED"), v.literal("AUTH_REQUIRED")),
  message: v.string(),
  retryAfterSeconds: v.optional(v.number()),
});
export type GuestError = Infer<typeof guestErrorValidator>;
export const guestSourceValidator = v.object({
  ...chatCitationValidator.fields,
  issuer: v.string(), officialCitation: v.string(),
  effectiveDate: v.union(v.string(), v.null()), sourceUrl: v.union(v.string(), v.null()),
});
export const guestResultValidator = v.object({
  requestId: v.string(), answer: v.string(), citations: v.array(guestSourceValidator), completedAt: v.number(),
  answerKind: v.union(v.literal("legal"), v.literal("policy")), partialCoverage: v.boolean(),
});
export const guestTurnValidator = v.object({
  requestId: v.string(), query: v.string(), status: widgetTurnStateValidator,
  result: v.optional(guestResultValidator), error: v.optional(guestErrorValidator),
});
export type GuestTurnView = Infer<typeof guestTurnValidator>;
export const guestSessionValidator = v.object({
  jurisdictionId: v.string(), jurisdictionName: v.string(), jurisdictionKind: jurisdictionKindValidator,
  expiresAt: v.number(), remaining: v.number(), turns: v.array(guestTurnValidator), chatId: v.optional(v.string()),
});
export type GuestSessionView = Infer<typeof guestSessionValidator>;
export const guestSessionResponseValidator = v.union(guestSessionValidator, v.object({ error: guestErrorValidator }));
