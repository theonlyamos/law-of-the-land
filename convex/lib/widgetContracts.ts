import { ConvexError, v, type Infer } from "convex/values";

export const WIDGET_LIMITS = {
  query: 4000, body: 32768, sessionBody: 2048, origins: 10,
  idleMs: 30 * 60_000, lifetimeMs: 24 * 60 * 60_000,
  leaseMs: 120_000, historyPairs: 10, historyBytes: 24 * 1024,
} as const;
export const organizationRoleValidator = v.union(v.literal("member"), v.literal("manager"), v.literal("reviewer"));
export const widgetSettingsFields = {
  enabled: v.boolean(), allowedOrigins: v.array(v.string()), title: v.string(),
  welcomeMessage: v.string(), suggestedQuestions: v.array(v.string()),
  accent: v.string(), side: v.union(v.literal("left"), v.literal("right")),
};
export const widgetSettingsValidator = v.object(widgetSettingsFields);
export type WidgetSettings = Infer<typeof widgetSettingsValidator>;
export type WidgetConfig = WidgetSettings & { publicId: string; jurisdictionName: string };
export const widgetErrorCodeValidator = v.union(
  v.literal("INVALID_REQUEST"), v.literal("BODY_TOO_LARGE"), v.literal("WIDGET_UNAVAILABLE"),
  v.literal("SESSION_EXPIRED"), v.literal("SESSION_INVALID"), v.literal("RATE_LIMITED"),
  v.literal("ALLOWANCE_EXHAUSTED"), v.literal("GENERATION_BUSY"), v.literal("REQUEST_CONFLICT"),
  v.literal("LIBRARY_CHANGED"), v.literal("GENERATION_TIMEOUT"), v.literal("ANSWER_UNAVAILABLE"), v.literal("TURN_NOT_FOUND"),
);
export type WidgetErrorCode = Infer<typeof widgetErrorCodeValidator>;
export const widgetErrorValidator = v.object({ code: widgetErrorCodeValidator, message: v.string(), retryAfterSeconds: v.optional(v.number()) });
export type WidgetError = Infer<typeof widgetErrorValidator>;
export const widgetSourceValidator = v.object({
  label: v.string(), jurisdictionId: v.string(), jurisdictionName: v.string(),
  jurisdictionKind: v.union(v.literal("geographic"), v.literal("organizational")), relation: v.literal("selected"),
  issuer: v.string(), officialCitation: v.string(), effectiveDate: v.union(v.string(), v.null()), sourceUrl: v.union(v.string(), v.null()),
});
export type WidgetSource = Infer<typeof widgetSourceValidator>;
export const widgetDoneValidator = v.object({ requestId: v.string(), answer: v.string(), citations: v.array(widgetSourceValidator), completedAt: v.number() });
export type WidgetDone = Infer<typeof widgetDoneValidator>;
export const widgetTurnStateValidator = v.union(v.literal("pending"), v.literal("completed"), v.literal("failed"), v.literal("aborted"));
export const widgetTurnViewValidator = v.object({ requestId: v.string(), status: widgetTurnStateValidator, result: v.optional(widgetDoneValidator), error: v.optional(widgetErrorValidator), retryAfterSeconds: v.optional(v.number()) });
export type WidgetTurnView = Infer<typeof widgetTurnViewValidator>;
export const widgetCitationIdentityValidator = v.object({ jurisdictionId: v.string(), resourceId: v.string(), versionId: v.string(), providerStoreName: v.string(), pageNumber: v.optional(v.number()) });
export type CitationIdentity = Infer<typeof widgetCitationIdentityValidator>;

export function normalizeWidgetOrigin(input: string, environment: "production" | "test" = "production"): string {
  if (input.length > 500 || /[?#\\\s]/u.test(input)) throw new ConvexError("INVALID_WEBSITE_ORIGIN");
  let url: URL;
  try { url = new URL(input); } catch { throw new ConvexError("INVALID_WEBSITE_ORIGIN"); }
  const testLoopback = environment === "test" && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((!testLoopback && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" || url.hostname.includes("*") || url.origin === "null") {
    throw new ConvexError("INVALID_WEBSITE_ORIGIN");
  }
  return url.origin;
}

export function normalizeWidgetSettings(input: WidgetSettings, environment: "production" | "test" = "production"): WidgetSettings {
  const text = (value: string, maximum: number, required = false) => {
    const result = value.trim();
    if (result.length > maximum || (required && !result) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(result)) throw new ConvexError("INVALID_WIDGET_SETTINGS");
    return result;
  };
  if (input.allowedOrigins.length > 10 || input.suggestedQuestions.length > 3 || !/^#[0-9a-f]{6}$/iu.test(input.accent) || !["left", "right"].includes(input.side)) throw new ConvexError("INVALID_WIDGET_SETTINGS");
  const allowedOrigins = [...new Set(input.allowedOrigins.map(origin => normalizeWidgetOrigin(origin, environment)))];
  if (input.enabled && !allowedOrigins.length) throw new ConvexError("WIDGET_WEBSITE_REQUIRED");
  return { enabled: input.enabled, allowedOrigins, title: text(input.title, 80, true), welcomeMessage: text(input.welcomeMessage, 300), suggestedQuestions: input.suggestedQuestions.map(q => text(q, 160, true)), accent: input.accent.toLowerCase(), side: input.side };
}
export function validWidgetRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
export function parseWidgetChatBody(bytes: Uint8Array): { requestId: string; query: string } {
  if (bytes.byteLength > WIDGET_LIMITS.body) throw new ConvexError("BODY_TOO_LARGE");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new ConvexError("INVALID_REQUEST"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConvexError("INVALID_REQUEST");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 2 || !validWidgetRequestId(body.requestId) || typeof body.query !== "string" || body.query.length > WIDGET_LIMITS.query || !body.query.trim()) throw new ConvexError("INVALID_REQUEST");
  return { requestId: body.requestId, query: body.query.trim() };
}
