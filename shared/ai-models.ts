/**
 * Every AI model the app calls, shared by Convex, the Next.js routes and the
 * admin panel. An admin setting wins; otherwise the old environment variables
 * apply, then the code default. Nothing here is secret: only model names.
 */

export const AI_MODEL_FEATURES = [
  "chat",
  "transcription",
  "document_review",
  "document_draft",
  "profile_memory",
  "source_verification",
  "intent_routing",
  "embedding",
] as const;
export type AiModelFeature = (typeof AI_MODEL_FEATURES)[number];

export type AiModelFeatureInfo = {
  label: string;
  description: string;
  provider: "Google Gemini" | "Typesafe";
  defaultModel: string;
  /** Environment variables read, in order, when no admin setting exists. */
  envVars: readonly string[];
  /** Where the model is called, which decides whose environment variables are the fallback. */
  runtime: "next" | "convex";
  /** Plain-language note on when a change takes effect. */
  appliesTo: string;
};

export const AI_MODEL_FEATURE_INFO: Record<AiModelFeature, AiModelFeatureInfo> = {
  chat: {
    label: "Chat answers",
    description: "Answers questions in the main chat, the embeddable widget and guest research, searching the legal library.",
    provider: "Google Gemini",
    defaultModel: "gemini-3.8-flash",
    envVars: ["GEMINI_AI_MODEL"],
    runtime: "next",
    appliesTo: "New questions, within about a minute.",
  },
  transcription: {
    label: "Voice input",
    description: "Turns recorded speech into text for the chat box.",
    provider: "Google Gemini",
    defaultModel: "gemini-3.5-transcribe",
    envVars: ["GEMINI_TRANSCRIBE_MODEL"],
    runtime: "next",
    appliesTo: "New recordings, within about a minute.",
  },
  document_review: {
    label: "Document review",
    description: "Reads an uploaded document and checks each passage against the law.",
    provider: "Google Gemini",
    defaultModel: "gemini-3.8-flash",
    envVars: ["DOCUMENT_REVIEW_MODEL", "GEMINI_AI_MODEL"],
    runtime: "convex",
    appliesTo: "Reviews started after the change.",
  },
  document_draft: {
    label: "Document drafting",
    description: "Plans, drafts and revises new documents.",
    provider: "Google Gemini",
    defaultModel: "gemini-3.8-flash",
    envVars: ["DOCUMENT_DRAFT_MODEL", "DOCUMENT_REVIEW_MODEL", "GEMINI_AI_MODEL"],
    runtime: "convex",
    appliesTo: "Drafting steps started after the change.",
  },
  profile_memory: {
    label: "Profile memory",
    description: "Picks out lasting facts about the user (such as where they live or work) from their questions.",
    provider: "Google Gemini",
    defaultModel: "gemini-3.8-flash",
    envVars: ["PROFILE_MEMORY_MODEL"],
    runtime: "convex",
    appliesTo: "Questions asked after the change.",
  },
  source_verification: {
    label: "Source checking",
    description: "Drafts and checks reviewed answers against their cited passages before they are shown.",
    provider: "Google Gemini",
    defaultModel: "gemini-3.8-flash",
    envVars: [],
    runtime: "next",
    appliesTo: "New checks, within about a minute. Responses must come back from the same model.",
  },
  intent_routing: {
    label: "Question sorting",
    description: "Sorts each chat message into a legal question, a greeting, unclear, or off-topic.",
    provider: "Typesafe",
    defaultModel: "jev-1.13.0",
    envVars: [],
    runtime: "next",
    appliesTo: "New questions, within about a minute.",
  },
  embedding: {
    label: "Search index embeddings",
    description: "Turns legal documents into search vectors when a jurisdiction's search index is created.",
    provider: "Google Gemini",
    defaultModel: "models/gemini-embedding-2",
    envVars: [],
    runtime: "convex",
    appliesTo: "Only search indexes created after the change. Existing indexes keep the model they were built with.",
  },
};

export const AI_MODEL_ID_MAX_LENGTH = 128;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/;

export function isAiModelFeature(value: unknown): value is AiModelFeature {
  return typeof value === "string" && (AI_MODEL_FEATURES as readonly string[]).includes(value);
}

/** Trims and checks a model ID. Embedding IDs gain the `models/` prefix Gemini expects. Returns null when invalid. */
export function normalizeAiModelId(feature: AiModelFeature, value: string): string | null {
  let model = value.trim();
  if (feature === "embedding" && model && !model.startsWith("models/")) model = `models/${model}`;
  if (!model || model.length > AI_MODEL_ID_MAX_LENGTH || !MODEL_ID_PATTERN.test(model) || model.includes("//") || model.endsWith("/")) return null;
  if (feature !== "embedding" && model.startsWith("models/")) model = model.slice("models/".length);
  return model && MODEL_ID_PATTERN.test(model) ? model : null;
}

export type AiModelOverrides = Partial<Record<AiModelFeature, string>>;

/** Admin setting, then the feature's environment variables, then the code default. */
export function resolveAiModel(
  feature: AiModelFeature,
  overrides: AiModelOverrides | null | undefined,
  environment: Record<string, string | undefined>,
): string {
  const stored = overrides?.[feature];
  if (stored) return stored;
  for (const name of AI_MODEL_FEATURE_INFO[feature].envVars) {
    const value = environment[name]?.trim();
    if (value) return value;
  }
  return AI_MODEL_FEATURE_INFO[feature].defaultModel;
}

export function resolveAiModels(
  overrides: AiModelOverrides | null | undefined,
  environment: Record<string, string | undefined>,
): Record<AiModelFeature, string> {
  return Object.fromEntries(AI_MODEL_FEATURES.map((feature) => [feature, resolveAiModel(feature, overrides, environment)])) as Record<AiModelFeature, string>;
}
