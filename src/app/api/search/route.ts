import { Groundx } from "groundx-typescript-sdk";
import { ConvexError } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { NextResponse } from "next/server";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { createOpaqueTelemetryToken, createTelemetryServiceProof } from "../../../../convex/lib/telemetryProof";
import { fetchAuthMutation, fetchAuthQuery, isAuthenticated } from "@/lib/auth-server";
import { planTopicScope, selectRetrievalScopeItems } from "@/lib/jurisdiction-topic-planner";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import {
  buildGovernedContext,
  runBoundedRetrieval,
  type ResearchAuthority,
} from "@/lib/research-limits";

const MAX_QUERY_LENGTH = 4_000;
const REQUESTS_PER_MINUTE = 15;
const issueCorrelation = makeFunctionReference<"mutation">("telemetry:issueCorrelation");
const recordSearchPhase = makeFunctionReference<"mutation">("telemetry:recordSearchPhase");
const LEGACY_ENDPOINT = "/internal/search-jurisdiction";
const UNIFIED_ENDPOINT = "/internal/search-jurisdictions";
const RESEARCH_UNAVAILABLE = "That jurisdiction is not available for research.";
const SEARCH_FAILURE = "We couldn't find relevant legal information for your question.";
const MAX_INTERNAL_RESPONSE_BYTES = 4_096;

type LegacyJurisdiction = { enabled: true; productionBucketId: string } | null;
type Selection = {
  id: Id<"jurisdictions">;
  name: string;
  slug: string;
  kind: "geographic" | "organizational";
  isDefault: boolean;
  legacyCountryCode?: string;
};
type Availability =
  | { jurisdictionId: string; status: "ready"; productionBucketId: string }
  | { jurisdictionId: string; status: "unconfigured" };
type AvailabilityResolution = { selected: Availability; supplementary: Availability[] };

function transportConfiguration() {
  const siteUrl = process.env.NEXT_PUBLIC_CONVEX_SITE_URL?.replace(/\/$/u, "");
  const secret = process.env.SEARCH_JURISDICTION_SECRET;
  if (!siteUrl || !secret || secret.length < 32) throw new Error("Search jurisdiction transport is not configured");
  return { siteUrl, secret };
}

async function protectedPost(path: string, body: object): Promise<unknown> {
  const { siteUrl, secret } = transportConfiguration();
  const response = await fetch(`${siteUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-search-jurisdiction-secret": secret },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("Search jurisdiction transport failed");
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_INTERNAL_RESPONSE_BYTES) {
    throw new Error("Search jurisdiction response invalid");
  }
  if (!response.body) throw new Error("Search jurisdiction response invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_INTERNAL_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Search jurisdiction response invalid");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Search jurisdiction response invalid");
  }
}

function positiveBucket(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseAvailability(value: unknown, expectedId: string): Availability | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.jurisdictionId !== expectedId) return null;
  if (row.status === "unconfigured" && exactKeys(row, ["jurisdictionId", "status"])) {
    return { jurisdictionId: expectedId, status: "unconfigured" };
  }
  if (row.status === "ready" && exactKeys(row, ["jurisdictionId", "productionBucketId", "status"]) && positiveBucket(row.productionBucketId) !== null) {
    return { jurisdictionId: expectedId, status: "ready", productionBucketId: row.productionBucketId as string };
  }
  return null;
}

function parseResolution(
  value: unknown,
  selectedId: string,
  supplementaryIds: readonly string[],
): AvailabilityResolution | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (!exactKeys(candidate, ["selected", "supplementary"]) || !Array.isArray(candidate.supplementary) || candidate.supplementary.length !== supplementaryIds.length) return null;
  const selected = parseAvailability(candidate.selected, selectedId);
  const supplementary = candidate.supplementary.map((row, index) => parseAvailability(row, supplementaryIds[index]));
  return selected && supplementary.every((row) => row !== null)
    ? { selected, supplementary: supplementary as Availability[] }
    : null;
}

async function recordQuestion() {
  try {
    await fetchAuthMutation(api.usage.recordQuestion, {});
    return null;
  } catch (error) {
    if (error instanceof ConvexError && (error.data as { code?: string })?.code === "QUOTA_EXCEEDED") {
      const data = error.data as { limit: number; isPro: boolean };
      return NextResponse.json({
        error: data.isPro
          ? `You have reached today's fair-use limit of ${data.limit} questions. It resets tomorrow.`
          : `You have used your ${data.limit} free questions for today. Upgrade to Pro for more, or come back tomorrow.`,
        code: "quota",
      }, { status: 402 });
    }
    throw error;
  }
}

async function legacySearch(query: string, body: Record<string, unknown>) {
  const omitted = body.country === undefined || body.country === null;
  const supplied = typeof body.country === "string" ? body.country.trim().toUpperCase() : "";
  const publicJurisdictions = omitted ? await fetchAuthQuery(api.jurisdictions.listPublicEnabled, {}) : null;
  const countryCode = omitted
    ? publicJurisdictions?.find((candidate) => candidate.isDefault)?.code ?? publicJurisdictions?.[0]?.code ?? ""
    : supplied;
  const jurisdiction = /^[A-Z]{2}$/u.test(countryCode)
    ? await protectedPost(LEGACY_ENDPOINT, { code: countryCode }) as LegacyJurisdiction
    : null;
  const productionBucket = positiveBucket(jurisdiction?.productionBucketId);
  if (jurisdiction?.enabled !== true || productionBucket === null) {
    return NextResponse.json({ error: "That country is not supported yet." }, { status: 400 });
  }
  const quota = await recordQuestion();
  if (quota) return quota;
  const correlationToken = createOpaqueTelemetryToken();
  await fetchAuthMutation(issueCorrelation, {
    token: correlationToken,
    jurisdictionCode: countryCode,
    serviceProof: await createTelemetryServiceProof(["issue", correlationToken, countryCode]),
  });
  const groundx = new Groundx({ apiKey: process.env.GROUNDX_API_KEY as string });
  const startedAt = performance.now();
  let response: Awaited<ReturnType<typeof groundx.search.content>>;
  try {
    response = await groundx.search.content({ id: productionBucket, query });
  } catch {
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    try {
      await fetchAuthMutation(recordSearchPhase, {
        token: correlationToken, providerStatus: "failure", latencyMs, resultCount: 0,
        serviceProof: await createTelemetryServiceProof(["search", correlationToken, "failure", latencyMs, 0]),
      });
    } catch { /* expiry is the terminal fallback */ }
    console.error("Search provider request failed");
    return NextResponse.json({ error: SEARCH_FAILURE }, { status: 500 });
  }
  const text = response.data.search.text;
  const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
  const providerStatus = text ? "success" as const : "no_result" as const;
  const resultCount = text ? 1 : 0;
  await fetchAuthMutation(recordSearchPhase, {
    token: correlationToken, providerStatus, latencyMs, resultCount,
    serviceProof: await createTelemetryServiceProof(["search", correlationToken, providerStatus, latencyMs, resultCount]),
  });
  return NextResponse.json({
    result: text || "No relevant legal information found for your question.",
    correlationToken,
    jurisdictionCode: countryCode,
  });
}

function unifiedSearchProof(
  token: string,
  data: {
    providerStatus: "success" | "no_result" | "failure";
    latencyMs: number; resultCount: number; scopeSize: number; retrievalPlanSize: number;
    providerCallCount: number; plannerStatus: "planned" | "fallback"; plannerLatencyMs: number;
    contextDigest?: string; partialCoverage: boolean; configurationUnavailableCount: number;
    supplementaryProviderFailureCount: number;
  },
) {
  return createTelemetryServiceProof([
    "search-jurisdiction-v1", token, data.providerStatus, data.latencyMs, data.resultCount,
    data.scopeSize, data.retrievalPlanSize, data.providerCallCount, data.plannerStatus,
    data.plannerLatencyMs, data.contextDigest ?? "", data.partialCoverage ? 1 : 0,
    data.configurationUnavailableCount, data.supplementaryProviderFailureCount,
  ]);
}

async function unifiedSearch(query: string, body: Record<string, unknown>) {
  if (!exactKeys(body, ["query", ...(body.jurisdictionId !== undefined ? ["jurisdictionId"] : []), ...(body.country !== undefined ? ["country"] : [])])) {
    return NextResponse.json({ error: RESEARCH_UNAVAILABLE }, { status: 400 });
  }
  const jurisdictionId = typeof body.jurisdictionId === "string" && body.jurisdictionId.trim()
    ? body.jurisdictionId.trim() as Id<"jurisdictions">
    : undefined;
  const country = typeof body.country === "string" && /^[A-Za-z]{2}$/u.test(body.country.trim()) ? body.country.trim().toUpperCase() : undefined;
  if ((!jurisdictionId && !country) || (body.jurisdictionId !== undefined && !jurisdictionId) || (body.country !== undefined && !country)) {
    return NextResponse.json({ error: RESEARCH_UNAVAILABLE }, { status: 400 });
  }
  let selection: Selection | null;
  try {
    selection = await fetchAuthQuery(api.jurisdictions.resolveResearchSelection, { jurisdictionId, country }) as Selection | null;
  } catch {
    selection = null;
  }
  if (!selection) return NextResponse.json({ error: RESEARCH_UNAVAILABLE }, { status: 400 });
  const quota = await recordQuestion();
  if (quota) return quota;
  const planner = await planTopicScope(query);
  const scope = await fetchAuthQuery(api.jurisdictions.resolveResearchScope, {
    jurisdictionId: selection.id,
    geographicHints: planner.geographicHints,
  });
  const plan = selectRetrievalScopeItems(scope, planner.ancestorDepth);
  if (plan.length === 0 || plan[0].jurisdictionId !== selection.id) throw new Error("Research scope invalid");
  const correlationToken = createOpaqueTelemetryToken();
  await fetchAuthMutation(issueCorrelation, {
    token: correlationToken,
    jurisdictionId: selection.id,
    ...(selection.legacyCountryCode ? { legacyCountryCode: selection.legacyCountryCode } : {}),
    serviceProof: await createTelemetryServiceProof([
      "issue-jurisdiction-v1", correlationToken, selection.id, selection.legacyCountryCode ?? "",
    ]),
  });
  const supplementaryIds = plan.slice(1).map((item) => item.jurisdictionId);
  const rawResolution = await protectedPost(UNIFIED_ENDPOINT, {
    selectedJurisdictionId: selection.id,
    supplementaryJurisdictionIds: supplementaryIds,
  });
  const resolution = parseResolution(rawResolution, selection.id, supplementaryIds);
  if (!resolution) throw new Error("Production availability response invalid");
  const startedAt = performance.now();
  if (resolution.selected.status === "unconfigured") {
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    const data = {
      providerStatus: "failure" as const, latencyMs, resultCount: 0,
      scopeSize: scope.items.length, retrievalPlanSize: plan.length, providerCallCount: 0,
      plannerStatus: planner.status, plannerLatencyMs: planner.latencyMs,
      partialCoverage: false, configurationUnavailableCount: 0,
      supplementaryProviderFailureCount: 0,
    };
    await fetchAuthMutation(recordSearchPhase, { ...data, token: correlationToken, serviceProof: await unifiedSearchProof(correlationToken, data) });
    return NextResponse.json({ error: RESEARCH_UNAVAILABLE }, { status: 400 });
  }
  const availability = [resolution.selected, ...resolution.supplementary];
  const ready = plan.flatMap((item, index) => {
    const itemAvailability = availability[index];
    return itemAvailability.status === "ready"
      ? [{ ...item, bucket: positiveBucket(itemAvailability.productionBucketId)! }]
      : [];
  });
  const groundx = new Groundx({ apiKey: process.env.GROUNDX_API_KEY as string });
  const settlements = await runBoundedRetrieval(ready, async (item, options) => {
    const response = await groundx.search.content(
      { id: item.bucket, query },
      { timeout: options.timeoutMs, signal: options.signal },
    );
    return typeof response.data.search.text === "string" ? response.data.search.text : "";
  });
  const selectedResult = settlements[0];
  const providerCallCount = settlements.filter((item) => item.status !== "not_started").length;
  const configurationUnavailable = new Set(
    plan.filter((_item, index) => index > 0 && availability[index].status === "unconfigured")
      .map((item) => item.jurisdictionId),
  );
  const providerFailures = new Set(
    settlements.filter((item) => item.job.relation !== "selected" && item.status !== "fulfilled")
      .map((item) => item.job.jurisdictionId),
  );
  if (!selectedResult || selectedResult.status !== "fulfilled") {
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    const data = {
      providerStatus: "failure" as const, latencyMs, resultCount: 0,
      scopeSize: scope.items.length, retrievalPlanSize: plan.length, providerCallCount,
      plannerStatus: planner.status, plannerLatencyMs: planner.latencyMs,
      partialCoverage: false, configurationUnavailableCount: configurationUnavailable.size,
      supplementaryProviderFailureCount: providerFailures.size,
    };
    try { await fetchAuthMutation(recordSearchPhase, { ...data, token: correlationToken, serviceProof: await unifiedSearchProof(correlationToken, data) }); } catch { /* expiry fallback */ }
    console.error("Search provider request failed");
    return NextResponse.json({ error: SEARCH_FAILURE }, { status: 500 });
  }
  const fulfilled = settlements.flatMap((item) => item.status === "fulfilled"
    ? [{ ...item.job, content: item.value }]
    : []);
  const governed = await buildGovernedContext(fulfilled);
  const missing = new Set([...configurationUnavailable, ...providerFailures]);
  const partialCoverage = plan.slice(1)
    .filter((item, index, rows) => missing.has(item.jurisdictionId) && rows.findIndex((row) => row.jurisdictionId === item.jurisdictionId) === index)
    .map(({ jurisdictionId: id, name, kind, relation }) => ({ jurisdictionId: id, name, kind, relation }));
  const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
  const resultCount = governed.sources.length;
  const data = {
    providerStatus: resultCount ? "success" as const : "no_result" as const,
    latencyMs, resultCount, scopeSize: scope.items.length, retrievalPlanSize: plan.length,
    providerCallCount, plannerStatus: planner.status, plannerLatencyMs: planner.latencyMs,
    contextDigest: governed.digest, partialCoverage: partialCoverage.length > 0,
    configurationUnavailableCount: configurationUnavailable.size,
    supplementaryProviderFailureCount: providerFailures.size,
  };
  await fetchAuthMutation(recordSearchPhase, { ...data, token: correlationToken, serviceProof: await unifiedSearchProof(correlationToken, data) });
  return NextResponse.json({
    result: governed.serialized,
    correlationToken,
    jurisdictionId: selection.id,
    ...(selection.legacyCountryCode ? { legacyCountryCode: selection.legacyCountryCode } : {}),
    ...(partialCoverage.length ? { partialCoverage } : {}),
  });
}

export async function POST(request: Request) {
  try {
    if (!(await isAuthenticated())) return NextResponse.json({ error: "Sign in to search the legal library." }, { status: 401 });
    const limit = rateLimit(`search:${clientKey(request)}`, REQUESTS_PER_MINUTE);
    if (!limit.ok) return NextResponse.json({ error: "You have sent several searches in a short time. Wait a minute, then try again." }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } });
    const raw = await request.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return NextResponse.json({ error: "That search could not be processed. Shorten it and try again." }, { status: 400 });
    const body = raw as Record<string, unknown>;
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query || query.length > MAX_QUERY_LENGTH) return NextResponse.json({ error: "That search could not be processed. Shorten it and try again." }, { status: 400 });
    const unified = await fetchAuthQuery(api.jurisdictions.isUnifiedJurisdictionsEnabled, {});
    return unified ? await unifiedSearch(query, body) : await legacySearch(query, body);
  } catch {
    console.error("Search request failed");
    return NextResponse.json({ error: SEARCH_FAILURE }, { status: 500 });
  }
}
