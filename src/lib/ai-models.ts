import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import {
  isAiModelFeature,
  normalizeAiModelId,
  resolveAiModels,
  type AiModelFeature,
  type AiModelOverrides,
} from "../../shared/ai-models";

const CACHE_MS = 30_000;
const TIMEOUT_MS = 1_500;
const overridesRef = makeFunctionReference<"query", Record<string, never>, AiModelOverrides>("aiModels:overrides");

let cached: { at: number; overrides: AiModelOverrides } | undefined;
let pending: Promise<AiModelOverrides> | undefined;

function clean(value: unknown): AiModelOverrides {
  const overrides: AiModelOverrides = {};
  if (!value || typeof value !== "object") return overrides;
  for (const [feature, model] of Object.entries(value)) {
    if (!isAiModelFeature(feature) || typeof model !== "string") continue;
    const normalized = normalizeAiModelId(feature, model);
    if (normalized) overrides[feature] = normalized;
  }
  return overrides;
}

async function fetchOverrides(): Promise<AiModelOverrides> {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) return {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("AI_MODEL_SETTINGS_TIMEOUT")), TIMEOUT_MS);
  });
  try {
    return clean(await Promise.race([new ConvexHttpClient(url).query(overridesRef, {}), timeout]));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Admin-chosen models, cached for 30 seconds per server instance. When Convex
 * cannot be reached the last known settings apply, or none, so a settings
 * outage falls back to environment variables and code defaults instead of
 * failing the request.
 */
async function readOverrides(): Promise<AiModelOverrides> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.overrides;
  pending ??= fetchOverrides()
    .then((overrides) => {
      cached = { at: Date.now(), overrides };
      return overrides;
    })
    .catch(() => {
      console.warn("ai_model_settings", JSON.stringify({ outcome: "unavailable" }));
      if (cached) cached = { at: Date.now(), overrides: cached.overrides };
      return cached?.overrides ?? {};
    })
    .finally(() => {
      pending = undefined;
    });
  return await pending;
}

/** Every model the Next.js routes call: admin setting, then environment variable, then code default. */
export async function getAiModels(environment: Record<string, string | undefined> = process.env): Promise<Record<AiModelFeature, string>> {
  return resolveAiModels(await readOverrides(), environment);
}

export async function getAiModel(feature: AiModelFeature): Promise<string> {
  return (await getAiModels())[feature];
}

/** For tests only. */
export function resetAiModelCacheForTests(): void {
  cached = undefined;
  pending = undefined;
}

/** Models with no admin settings applied: environment variables, then code defaults. */
export function aiModelsFromEnvironment(environment: Record<string, string | undefined> = process.env): Record<AiModelFeature, string> {
  return resolveAiModels(null, environment);
}
