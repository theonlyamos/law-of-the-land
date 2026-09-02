import { ConvexError } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { NextResponse } from "next/server";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { createOpaqueTelemetryToken, createTelemetryServiceProof } from "../../../../convex/lib/telemetryProof";
import {
  createResearchManifestHeaders,
  createResearchManifestNonce,
} from "../../../../convex/lib/researchManifestProof";
import type { RetrievalObservationV2 } from "../../../../shared/e2e-jurisdiction-provider-contract";
import { fetchAuthMutation, fetchAuthQuery, isAuthenticated } from "@/lib/auth-server";
import {
  authorizedObservationSecret,
  encodeRetrievalObservationV2,
  resolveJurisdictionProviderMode,
  type JurisdictionProviderMode,
} from "@/lib/e2e-jurisdiction-provider-isolation";
import { createResearchProvider, createTopicProvider } from "@/lib/jurisdiction-provider-adapters";
import { planTopicScope, selectRetrievalScopeItems } from "@/lib/jurisdiction-topic-planner";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import { buildGovernedContext, DEFAULT_RETRIEVAL_TIMEOUT_MS, DEFAULT_TOTAL_RETRIEVAL_TIMEOUT_MS, type ResearchAuthority, type TrustedCitation } from "@/lib/research-limits";

const MAX_QUERY_LENGTH = 4_000;
const REQUESTS_PER_MINUTE = 15;
const MAX_INTERNAL_RESPONSE_BYTES = 262_144;
const MAX_ID_LENGTH = 200;
const MAX_DOCUMENTS_PER_STORE = 64;
const MAX_CITATION_KEYS = 64;
const MAX_CITATION_ID_LENGTH = 128;
const UNIFIED_ENDPOINT = "/internal/search-jurisdictions";
const RESEARCH_UNAVAILABLE = "That jurisdiction is not available for research.";
const SEARCH_FAILURE = "We couldn't find relevant legal information for your question.";
const OBSERVATION_RESPONSE_HEADER = "x-admin-e2e-retrieval-plan-v2";
const STORE_NAME = /^fileSearchStores\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u;
const DOCUMENT_NAME = /^fileSearchStores\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\/documents\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u;
const issueCorrelation = makeFunctionReference<"mutation">("telemetry:issueCorrelation");
const recordSearchPhase = makeFunctionReference<"mutation">("telemetry:recordSearchPhase");

type Selection = {
  id: Id<"jurisdictions">;
  name: string;
  slug: string;
  kind: "geographic" | "organizational";
  isDefault: boolean;
  legacyCountryCode?: string;
};
type ManifestDocument = {
  resourceId: string;
  versionId: string;
  documentName: string;
  title: string;
  officialCitation: string;
  sourceUrl: string;
};
type Availability =
  | { jurisdictionId: string; status: "ready"; storeName: string; documents: ManifestDocument[] }
  | { jurisdictionId: string; status: "unconfigured" | "provisioning" | "needs_review" };
type AvailabilityResolution = { selected: Availability; supplementary: Availability[] };
type PlanItem = ResearchAuthority & { ordinal: 0 | 1 | 2 | 3 };
type CitationKey = { jurisdictionId: string; resourceId: string; versionId: string };

function elapsed(startedAt: number) { return Math.max(0, Math.round(performance.now() - startedAt)); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function boundedString(value: unknown, maximum = MAX_ID_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value === value.trim();
}
function trustedUrl(value: unknown): value is string {
  if (!boundedString(value, 2_048)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch { return false; }
}

function parseAvailability(value: unknown, expectedId: string): Availability | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.jurisdictionId !== expectedId) return null;
  if (["unconfigured", "provisioning", "needs_review"].includes(String(row.status))
    && exactKeys(row, ["jurisdictionId", "status"])) {
    return row as Availability;
  }
  if (row.status !== "ready" || !exactKeys(row, ["documents", "jurisdictionId", "status", "storeName"])
    || typeof row.storeName !== "string" || !STORE_NAME.test(row.storeName)
    || !Array.isArray(row.documents) || row.documents.length > MAX_DOCUMENTS_PER_STORE) return null;
  const seen = new Set<string>();
  const documents: ManifestDocument[] = [];
  for (const raw of row.documents) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const document = raw as Record<string, unknown>;
    if (!exactKeys(document, ["documentName", "officialCitation", "resourceId", "sourceUrl", "title", "versionId"])
      || !boundedString(document.resourceId) || !boundedString(document.versionId)
      || !boundedString(document.title, 300) || !boundedString(document.officialCitation, 300)
      || !trustedUrl(document.sourceUrl) || typeof document.documentName !== "string"
      || !DOCUMENT_NAME.test(document.documentName)
      || !document.documentName.startsWith(`${row.storeName}/documents/`)) return null;
    const key = `${document.resourceId}\u0000${document.versionId}`;
    if (seen.has(key)) return null;
    seen.add(key);
    documents.push(document as ManifestDocument);
  }
  return { jurisdictionId: expectedId, status: "ready", storeName: row.storeName, documents };
}

function parseResolution(value: unknown, selectedId: string, supplementaryIds: readonly string[]): AvailabilityResolution | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (!exactKeys(candidate, ["selected", "supplementary"]) || !Array.isArray(candidate.supplementary)
    || candidate.supplementary.length !== supplementaryIds.length) return null;
  const selected = parseAvailability(candidate.selected, selectedId);
  const supplementary = candidate.supplementary.map((row, index) => parseAvailability(row, supplementaryIds[index]));
  if (!selected || supplementary.some((row) => row === null)) return null;
  const stores = [selected, ...supplementary].flatMap((row) => row?.status === "ready" ? [row.storeName] : []);
  if (new Set(stores).size !== stores.length) return null;
  return { selected, supplementary: supplementary as Availability[] };
}

function transportConfiguration() {
  const siteUrl = process.env.NEXT_PUBLIC_CONVEX_SITE_URL?.replace(/\/$/u, "");
  const secret = process.env.SEARCH_JURISDICTION_SECRET;
  if (!siteUrl || !secret || secret.length < 32) throw new Error("Search jurisdiction transport is not configured");
  return { siteUrl, secret };
}
function remainingRetrievalMs(overallDeadlineAt: number) {
  const remainingMs = Math.floor(overallDeadlineAt - performance.now());
  if (remainingMs <= 0) throw new Error("Research retrieval deadline exceeded");
  return remainingMs;
}
async function protectedPost(body: object, overallDeadlineAt: number): Promise<unknown> {
  const { siteUrl, secret } = transportConfiguration();
  const bodyBytes = new TextEncoder().encode(JSON.stringify(body));
  const proofHeaders = await createResearchManifestHeaders({
    secret,
    method: "POST",
    pathname: UNIFIED_ENDPOINT,
    timestamp: Date.now(),
    nonce: createResearchManifestNonce(),
    bodyBytes,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remainingRetrievalMs(overallDeadlineAt));
  try {
    const response = await fetch(`${siteUrl}${UNIFIED_ENDPOINT}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...proofHeaders },
      body: bodyBytes,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("Search jurisdiction transport failed");
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_INTERNAL_RESPONSE_BYTES) throw new Error("Search jurisdiction response invalid");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_INTERNAL_RESPONSE_BYTES) throw new Error("Search jurisdiction response invalid");
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new Error("Search jurisdiction response invalid"); }
  } finally {
    clearTimeout(timer);
  }
}
async function availability(
  selectedId: string,
  supplementaryIds: readonly string[],
  overallDeadlineAt: number,
  citationKeys?: readonly CitationKey[],
) {
  const raw = await protectedPost({
    selectedJurisdictionId: selectedId,
    supplementaryJurisdictionIds: supplementaryIds,
    ...(citationKeys === undefined ? {} : { citationKeys }),
  }, overallDeadlineAt);
  const parsed = parseResolution(raw, selectedId, supplementaryIds);
  if (!parsed) throw new Error("Research availability response invalid");
  return parsed;
}

function citationKeysForPostflight(
  sources: unknown,
  allowedJurisdictionIds: ReadonlySet<string>,
): CitationKey[] | null {
  if (!Array.isArray(sources)) return null;
  const seen = new Set<string>();
  const keys: CitationKey[] = [];
  for (const rawSource of sources) {
    if (!rawSource || typeof rawSource !== "object" || Array.isArray(rawSource)) continue;
    const source = rawSource as { jurisdictionId?: unknown; spans?: unknown };
    if (!boundedString(source.jurisdictionId) || !allowedJurisdictionIds.has(source.jurisdictionId)
      || !Array.isArray(source.spans)) continue;
    for (const rawSpan of source.spans) {
      if (!rawSpan || typeof rawSpan !== "object" || Array.isArray(rawSpan)) continue;
      const citation = (rawSpan as { citation?: unknown }).citation;
      if (!citation || typeof citation !== "object" || Array.isArray(citation)) continue;
      const candidate = citation as { resourceId?: unknown; versionId?: unknown };
      if (!boundedString(candidate.resourceId, MAX_CITATION_ID_LENGTH)
        || !boundedString(candidate.versionId, MAX_CITATION_ID_LENGTH)) continue;
      const identity = `${source.jurisdictionId}\u0000${candidate.resourceId}\u0000${candidate.versionId}`;
      if (seen.has(identity)) continue;
      if (keys.length >= MAX_CITATION_KEYS) return null;
      seen.add(identity);
      keys.push({
        jurisdictionId: source.jurisdictionId,
        resourceId: candidate.resourceId,
        versionId: candidate.versionId,
      });
    }
  }
  return keys;
}

async function recordQuestion() {
  try { await fetchAuthMutation(api.usage.recordQuestion, {}); return null; }
  catch (error) {
    if (error instanceof ConvexError && (error.data as { code?: string })?.code === "QUOTA_EXCEEDED") {
      const data = error.data as { limit: number; isPro: boolean };
      return NextResponse.json({ error: data.isPro
        ? `You have reached today's fair-use limit of ${data.limit} questions. It resets tomorrow.`
        : `You have used your ${data.limit} free questions for today. Upgrade to Pro for more, or come back tomorrow.`, code: "quota" }, { status: 402 });
    }
    throw error;
  }
}

function availabilityMessage(name: string, status: Exclude<Availability["status"], "ready">) {
  if (status === "provisioning") return `Gemini search is being set up for ${name}. You can leave this page; the status updates automatically.`;
  if (status === "needs_review") return `Search is paused for ${name} because its index needs review.`;
  return `Search is not set up for ${name}.`;
}

function authorizeCitation(
  jurisdictionId: string,
  citation: { resourceId: string; versionId: string; pageNumber?: number },
  manifest: Availability,
): { key: string; citation: TrustedCitation } | null {
  if (manifest.status !== "ready") return null;
  const document = manifest.documents.find((candidate) => candidate.resourceId === citation.resourceId
    && candidate.versionId === citation.versionId);
  if (!document) return null;
  return {
    key: `${jurisdictionId}\u0000${document.resourceId}\u0000${document.versionId}\u0000${citation.pageNumber ?? ""}`,
    citation: { title: document.title, officialCitation: document.officialCitation, sourceUrl: document.sourceUrl, ...(citation.pageNumber === undefined ? {} : { pageNumber: citation.pageNumber }) },
  };
}

function observation(plan: readonly PlanItem[], available: readonly Availability[], sourceIds: ReadonlySet<string>, metrics: { scopeSize: number; callCount: 0 | 1; storeCount: number; fileSearchLatencyMs: number; totalLatencyMs: number; evidenceBytes: number; citationCount: number }): RetrievalObservationV2 {
  const jurisdictions = plan.map((item, index) => ({
    ordinal: index as 0 | 1 | 2 | 3,
    relation: item.relation,
    coverage: available[index]?.status !== "ready" ? "unavailable" as const : sourceIds.has(item.jurisdictionId) ? "evidence" as const : "no_evidence" as const,
  }));
  return { version: 2, authorizedScopeSize: metrics.scopeSize, planSize: plan.length, fileSearchCallCount: metrics.callCount,
    fileSearchStoreCount: metrics.storeCount, fileSearchLatencyMs: metrics.fileSearchLatencyMs, totalLatencyMs: metrics.totalLatencyMs,
    evidenceBytes: metrics.evidenceBytes, citationCount: metrics.citationCount,
    partialCoverage: jurisdictions.slice(1).some(({ coverage }) => coverage !== "evidence"), jurisdictions, unexpectedRealProviderCallCount: 0 };
}
function addObservation(response: NextResponse, authorized: boolean, value: RetrievalObservationV2) {
  if (authorized) response.headers.set(OBSERVATION_RESPONSE_HEADER, encodeRetrievalObservationV2(value));
  return response;
}
type SearchTelemetry = {
  providerStatus: "success" | "failure";
  totalLatencyMs: number;
  resultCount: number;
  scopeSize: number;
  retrievalPlanSize: number;
  fileSearchCallCount: number;
  fileSearchStoreCount: number;
  fileSearchLatencyMs: number;
  evidenceBytes: number;
  citationCount: number;
  contextDigest?: string;
  partialCoverage: boolean;
  jurisdictionCoverage: Array<{ ordinal: number; relation: string; coverage: string }>;
};
function searchProof(token: string, data: SearchTelemetry) {
  return createTelemetryServiceProof(["search-jurisdiction-v2", token, data.providerStatus, data.totalLatencyMs,
    data.resultCount, data.scopeSize, data.retrievalPlanSize, data.fileSearchCallCount, data.fileSearchStoreCount,
    data.fileSearchLatencyMs, data.evidenceBytes, data.citationCount, data.contextDigest ?? "", data.partialCoverage ? 1 : 0,
    data.jurisdictionCoverage
      .map((item) => `${item.ordinal}:${item.relation}:${item.coverage}`).join("|")]);
}

async function governedSearch(query: string, body: Record<string, unknown>, mode: JurisdictionProviderMode, observationAuthorized: boolean) {
  const totalStartedAt = performance.now();
  const overallDeadlineAt = totalStartedAt + DEFAULT_TOTAL_RETRIEVAL_TIMEOUT_MS;
  if (!exactKeys(body, ["query", ...(body.jurisdictionId !== undefined ? ["jurisdictionId"] : []), ...(body.country !== undefined ? ["country"] : [])]))
    return NextResponse.json({ error: RESEARCH_UNAVAILABLE }, { status: 400 });
  const jurisdictionId = boundedString(body.jurisdictionId) ? body.jurisdictionId as Id<"jurisdictions"> : undefined;
  const country = typeof body.country === "string" && /^[A-Za-z]{2}$/u.test(body.country.trim()) ? body.country.trim().toUpperCase() : undefined;
  if ((!jurisdictionId && !country) || (body.jurisdictionId !== undefined && !jurisdictionId) || (body.country !== undefined && !country))
    return NextResponse.json({ error: RESEARCH_UNAVAILABLE }, { status: 400 });
  let selection: Selection | null = null;
  try { selection = await fetchAuthQuery(api.jurisdictions.resolveResearchSelection, { jurisdictionId, country }) as Selection | null; } catch { /* sanitized below */ }
  if (!selection) return NextResponse.json({ error: RESEARCH_UNAVAILABLE }, { status: 400 });

  const selectedPreflight = await availability(selection.id, [], overallDeadlineAt);
  if (selectedPreflight.selected.status !== "ready") {
    return NextResponse.json({ error: availabilityMessage(selection.name, selectedPreflight.selected.status) }, { status: 400 });
  }
  const quota = await recordQuestion();
  if (quota) return quota;
  const topicProvider = createTopicProvider(process.env, {}, mode);
  const planner = await planTopicScope(query, async (request) => await topicProvider.generate(query, request));
  const scope = await fetchAuthQuery(api.jurisdictions.resolveResearchScope, { jurisdictionId: selection.id, geographicHints: planner.geographicHints });
  const rawPlan = selectRetrievalScopeItems(scope, planner.ancestorDepth);
  if (rawPlan.length === 0 || rawPlan[0].jurisdictionId !== selection.id) throw new Error("Research scope invalid");
  const plan = rawPlan.map((item, index) => ({ ...item, ordinal: index as 0 | 1 | 2 | 3 }));
  const full = await availability(selection.id, plan.slice(1).map(({ jurisdictionId: id }) => id), overallDeadlineAt);
  const available = [full.selected, ...full.supplementary];
  if (full.selected.status !== "ready") return NextResponse.json({ error: availabilityMessage(selection.name, full.selected.status) }, { status: 400 });
  if (full.selected.storeName !== selectedPreflight.selected.storeName) {
    return NextResponse.json({ error: RESEARCH_UNAVAILABLE }, { status: 400 });
  }

  const correlationToken = createOpaqueTelemetryToken();
  const legacyResolutionUsed = jurisdictionId === undefined;
  await fetchAuthMutation(issueCorrelation, { token: correlationToken, jurisdictionId: selection.id, legacyResolutionUsed,
    ...(selection.legacyCountryCode ? { legacyCountryCode: selection.legacyCountryCode } : {}),
    serviceProof: await createTelemetryServiceProof(["issue-jurisdiction-v1", correlationToken, selection.id, selection.legacyCountryCode ?? "", legacyResolutionUsed ? 1 : 0]) });
  const stores = plan.flatMap((item, index) => available[index].status === "ready"
    ? [{
        jurisdictionId: item.jurisdictionId,
        name: item.name,
        kind: item.kind,
        relation: item.relation,
        storeName: available[index].storeName,
        ...(mode.mode === "stub" ? {
          documents: available[index].documents.map(({ resourceId, versionId, documentName }) => ({
            resourceId,
            versionId,
            documentName,
          })),
        } : {}),
      }]
    : []);
  const provider = createResearchProvider(process.env, {}, mode);
  async function failedSearch(
    callCount: 0 | 1,
    fileSearchLatencyMs: number,
    finalAvailability: readonly Availability[] = available,
    response = NextResponse.json({ error: SEARCH_FAILURE }, { status: 500 }),
  ) {
    const totalLatencyMs = Math.max(elapsed(totalStartedAt), fileSearchLatencyMs);
    const obs = observation(plan, finalAvailability, new Set(), { scopeSize: scope.items.length, callCount,
      storeCount: callCount === 1 ? stores.length : 0, fileSearchLatencyMs, totalLatencyMs, evidenceBytes: 0, citationCount: 0 });
    const data = { providerStatus: "failure" as const, totalLatencyMs, resultCount: 0, scopeSize: scope.items.length, retrievalPlanSize: plan.length,
      fileSearchCallCount: callCount, fileSearchStoreCount: callCount === 1 ? stores.length : 0, fileSearchLatencyMs, evidenceBytes: 0, citationCount: 0,
      partialCoverage: obs.partialCoverage, jurisdictionCoverage: obs.jurisdictions };
    try { await fetchAuthMutation(recordSearchPhase, { token: correlationToken, ...data, serviceProof: await searchProof(correlationToken, data) }); } catch { /* expiry fallback */ }
    return addObservation(
      response,
      observationAuthorized,
      obs,
    );
  }
  const retrievalController = new AbortController();
  const retrievalStartedAt = performance.now();
  let rejectDeadline: (() => void) | undefined;
  const deadlineReached = new Promise<never>((_resolve, reject) => {
    rejectDeadline = () => reject(new Error("FILE_SEARCH_TIMEOUT"));
  });
  const fileSearchTimeoutMs = Math.min(DEFAULT_RETRIEVAL_TIMEOUT_MS, remainingRetrievalMs(overallDeadlineAt));
  const deadlineTimer = setTimeout(() => {
    retrievalController.abort();
    rejectDeadline?.();
  }, fileSearchTimeoutMs);
  try { await Promise.race([provider.initialize(), deadlineReached]); }
  catch {
    clearTimeout(deadlineTimer);
    return await failedSearch(0, 0);
  }
  const callStartedAt = performance.now();
  let result;
  try {
    const remainingMs = Math.min(
      remainingRetrievalMs(overallDeadlineAt),
      Math.max(1, Math.floor(fileSearchTimeoutMs - (performance.now() - retrievalStartedAt))),
    );
    result = await Promise.race([
      provider.search({ query, stores }, { signal: retrievalController.signal, timeoutMs: remainingMs }),
      deadlineReached,
    ]);
  } catch {
    return await failedSearch(1, Math.min(DEFAULT_RETRIEVAL_TIMEOUT_MS, elapsed(callStartedAt)));
  } finally {
    clearTimeout(deadlineTimer);
  }
  if (!Number.isSafeInteger(result.latencyMs) || result.latencyMs < 0 || result.latencyMs > DEFAULT_RETRIEVAL_TIMEOUT_MS) {
    return await failedSearch(1, Math.min(DEFAULT_RETRIEVAL_TIMEOUT_MS, elapsed(callStartedAt)));
  }
  const citationKeys = citationKeysForPostflight(
    result.sources,
    new Set(stores.map(({ jurisdictionId: id }) => id)),
  );
  if (!citationKeys) return await failedSearch(1, result.latencyMs);

  let postflight: AvailabilityResolution;
  try {
    postflight = await availability(
      selection.id,
      plan.slice(1).map(({ jurisdictionId: id }) => id),
      overallDeadlineAt,
      citationKeys,
    );
  } catch {
    return await failedSearch(1, result.latencyMs);
  }
  const fresh = [postflight.selected, ...postflight.supplementary];
  const selectedFresh = fresh[0];
  if (selectedFresh.status !== "ready"
    || selectedFresh.storeName !== (available[0].status === "ready" ? available[0].storeName : "")) {
    const finalAvailability: Availability[] = [
      { jurisdictionId: selection.id, status: "needs_review" },
      ...fresh.slice(1),
    ];
    return await failedSearch(
      1,
      result.latencyMs,
      finalAvailability,
      NextResponse.json({ error: RESEARCH_UNAVAILABLE }, { status: 400 }),
    );
  }
  const finalAvailability = fresh.map((current, index): Availability => {
    const before = available[index];
    if (before.status !== "ready" || current.status !== "ready" || before.storeName !== current.storeName) {
      return { jurisdictionId: plan[index].jurisdictionId, status: "needs_review" };
    }
    return current;
  });

  const sourceById = new Map(result.sources.map((source) => [source.jurisdictionId, source]));
  const selectedSource = sourceById.get(selection.id);
  if (!selectedSource || selectedSource.spans.length === 0) {
    return await failedSearch(1, result.latencyMs, finalAvailability);
  }
  const usedCitations = new Set<string>();
  const sources = plan.flatMap((item, index) => {
    const source = sourceById.get(item.jurisdictionId);
    if (!source || finalAvailability[index].status !== "ready") return [];
    const spans = source.spans.flatMap((span) => {
      const authorized = authorizeCitation(item.jurisdictionId, span.citation, finalAvailability[index]);
      return authorized && span.content.trim() ? [{ content: span.content, ...authorized }] : [];
    });
    if (spans.length === 0) return [];
    const citations = spans.flatMap(({ key, citation }) => {
      if (usedCitations.has(key)) return [];
      usedCitations.add(key);
      return [citation];
    });
    return [{ ...item, content: spans.map(({ content }) => content).join("\n\n"), citations }];
  });
  if (!sources.some(({ jurisdictionId }) => jurisdictionId === selection.id)) {
    return await failedSearch(1, result.latencyMs, finalAvailability);
  }
  const governed = await buildGovernedContext(sources);
  const governedSourceIds = new Set(governed.sources.map(({ jurisdictionId: id }) => id));
  if (!governedSourceIds.has(selection.id)) {
    return await failedSearch(1, result.latencyMs, finalAvailability);
  }
  const evidenceBytes = governed.sources.reduce((sum, source) => sum + new TextEncoder().encode(source.content).byteLength, 0);
  const citationCount = governed.sources.reduce((sum, source) => sum + (source.citations?.length ?? 0), 0);
  const partialCoverage = plan.slice(1).filter((item) => !governedSourceIds.has(item.jurisdictionId))
    .map(({ jurisdictionId: id, name, kind, relation }) => ({ jurisdictionId: id, name, kind, relation }));
  const totalLatencyMs = Math.max(elapsed(totalStartedAt), result.latencyMs);
  const obs = observation(plan, finalAvailability, governedSourceIds, { scopeSize: scope.items.length, callCount: 1, storeCount: stores.length,
    fileSearchLatencyMs: result.latencyMs, totalLatencyMs, evidenceBytes, citationCount });
  const data = { providerStatus: "success" as const, totalLatencyMs, resultCount: governed.sources.length, scopeSize: scope.items.length,
    retrievalPlanSize: plan.length, fileSearchCallCount: 1, fileSearchStoreCount: stores.length, fileSearchLatencyMs: result.latencyMs,
    evidenceBytes, citationCount, contextDigest: governed.digest, partialCoverage: obs.partialCoverage, jurisdictionCoverage: obs.jurisdictions };
  await fetchAuthMutation(recordSearchPhase, { token: correlationToken, ...data, serviceProof: await searchProof(correlationToken, data) });
  return addObservation(NextResponse.json({ result: governed.serialized, correlationToken, jurisdictionId: selection.id,
    ...(selection.legacyCountryCode ? { legacyCountryCode: selection.legacyCountryCode } : {}),
    ...(partialCoverage.length ? { partialCoverage } : {}) }), observationAuthorized, obs);
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
    const mode = resolveJurisdictionProviderMode(process.env);
    return await governedSearch(query, body, mode, authorizedObservationSecret(request, mode));
  } catch {
    console.error("Search request failed");
    return NextResponse.json({ error: SEARCH_FAILURE }, { status: 500 });
  }
}
