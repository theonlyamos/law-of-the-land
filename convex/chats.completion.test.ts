/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import authSchema from "./betterAuth/schema";
import { createCitationClaimBindings } from "./lib/chatCitationClaim";
import {
  createOpaqueTelemetryToken,
  createTelemetryServiceProof,
} from "./lib/telemetryProof";
import schema from "./schema";
import { CHAT_POLICY_RESPONSES } from "./lib/chatPolicy";
import { queryDiagnosticsProofParts, validateQueryDiagnostics, type QueryDiagnostics } from "./lib/queryDiagnostics";
import { completeGovernedInteractionProofParts } from "./chats";

const modules = import.meta.glob("./**/*.ts");
const authModules = Object.fromEntries(
  Object.entries(import.meta.glob("./betterAuth/**/*.ts")).map(([path, load]) => [
    `./${path.slice("./betterAuth/".length)}`,
    load,
  ]),
);

type Backend = TestConvex<typeof schema>;
type Client = ReturnType<Backend["withIdentity"]>;
type Outcome = "success" | "failure" | "aborted";
type FailureCategory =
  | "authentication"
  | "configuration"
  | "network"
  | "timeout"
  | "validation"
  | "internal";
type CitationIdentity = {
  jurisdictionId: string;
  resourceId: string;
  versionId: string;
  providerStoreName: string;
  pageNumber?: number;
};
type Coverage = {
  ordinal: number;
  relation: "selected" | "geographic_ancestor" | "organizational_geography";
  coverage: "evidence" | "no_evidence" | "unavailable" | "not_searched";
};
const TEST_DIAGNOSTICS: QueryDiagnostics = {
  version: 1 as const, phase: "canonical_read" as const, reason: "completed" as const,
  searchCallCount: 1, searchResultCount: 1, searchResultItemCount: 2,
  streamedAnnotationCount: 1, canonicalAnnotationCount: 1,
  canonicalReadCompleted: true, countsClamped: false,
  citationUriKind: "authorized_store" as const,
  jurisdictionMetadataPresent: true, resourceMetadataPresent: true, versionMetadataPresent: true,
};
type CompletionInput = {
  routeNonce: string;
  externalId: string;
  jurisdictionId: string;
  assistantClientId: string;
  finalAnswer?: string;
  answerKind?: "legal" | "policy";
  citations: CitationIdentity[];
  model: string;
  elapsedMs: number;
  outcome: Outcome;
  failureCategory?: FailureCategory;
  authorizedScopeSize: number;
  readyStoreCount: number;
  partialCoverage: boolean;
  jurisdictionCoverage: Coverage[];
  diagnostics?: QueryDiagnostics;
};

const completeGovernedInteraction = makeFunctionReference<"mutation">(
  "chats:completeGovernedInteraction",
);
const SECRET = "governed-completion-test-secret-at-least-32-chars";
const previous = {
  secret: process.env.TELEMETRY_INGEST_SECRET,
  environment: process.env.ADMIN_ENVIRONMENT,
};

function backend(): Backend {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  return t;
}

async function user(t: Backend, label: string) {
  const identity = await t.run(async (ctx) => {
    const now = Date.now();
    const account = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          name: label,
          email: `${label}-${crypto.randomUUID()}@example.com`,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
          role: "user",
          banned: false,
          twoFactorEnabled: false,
        },
      },
    });
    const session = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "session",
        data: {
          token: crypto.randomUUID(),
          userId: account._id,
          expiresAt: now + 86_400_000,
          createdAt: now,
          updatedAt: now,
        },
      },
    });
    return { userId: account._id, sessionId: session._id };
  });
  return {
    userId: identity.userId,
    client: t.withIdentity({
      subject: identity.userId,
      sessionId: identity.sessionId,
    }),
  };
}

async function geographicJurisdiction(t: Backend, name: string) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const slug = `${name.toLowerCase().replaceAll(" ", "-")}-${crypto.randomUUID().slice(0, 8)}`;
    const storeName = `fileSearchStores/${slug}`;
    const jurisdictionId = await ctx.db.insert("jurisdictions", {
      name,
      slug,
      status: "enabled",
      isDefault: false,
      geminiFileSearchStoreName: storeName,
      geminiEmbeddingModel: "models/gemini-embedding-2",
      providerSyncState: "synced",
      kind: "geographic",
      visibility: "public",
      createdBy: "fixture",
      updatedBy: "fixture",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("geographicJurisdictions", {
      jurisdictionId,
      googlePlaceId: `place-${slug}`,
      level: "country",
      latitude: 0,
      longitude: 0,
      formattedAddress: name,
      createdAt: now,
      updatedAt: now,
    });
    return { jurisdictionId, storeName };
  });
}

async function attachReadyParent(
  t: Backend,
  selectedJurisdictionId: Id<"jurisdictions">,
) {
  const parent = await geographicJurisdiction(t, "West Africa");
  await t.run(async (ctx) => {
    const selectedProfiles = await ctx.db
      .query("geographicJurisdictions")
      .withIndex("by_jurisdictionId", (q) =>
        q.eq("jurisdictionId", selectedJurisdictionId))
      .take(2);
    if (selectedProfiles.length !== 1) throw new Error("Invalid selected fixture");
    await ctx.db.patch(selectedProfiles[0]._id, {
      level: "city",
      parentJurisdictionId: parent.jurisdictionId,
      updatedAt: Date.now(),
    });
  });
  return parent;
}

async function publishedDocument(
  t: Backend,
  jurisdictionId: Id<"jurisdictions">,
  storeName: string,
  title = "Constitution of Ghana",
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const originalStorageId = await ctx.storage.store(new Blob(["law"]));
    const resourceId = await ctx.db.insert("legalResources", {
      jurisdictionId,
      type: "constitution",
      title,
      issuer: "Parliament",
      officialCitation: "Const. 1992",
      officialCitationKey: "const. 1992",
      sourceUrl: "https://official.example/law",
      topics: ["constitutional law"],
      effectiveDate: "1992-05-07",
      status: "active",
      createdBy: "fixture",
      updatedBy: "fixture",
      createdAt: now,
      updatedAt: now,
    });
    const versionId = await ctx.db.insert("documentVersions", {
      resourceId,
      versionNumber: 1,
      originalStorageId,
      filename: "constitution.pdf",
      mimeType: "application/pdf",
      byteSize: 3,
      sha256: "a".repeat(64),
      sourceUrl: "https://official.example/law",
      status: "published",
      geminiDocumentName: `${storeName}/documents/constitution`,
      submittedBy: "fixture",
      publishedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(resourceId, { activeVersionId: versionId });
    return {
      resourceId,
      versionId,
      providerDocumentName: `${storeName}/documents/constitution`,
    };
  });
}

async function fixture() {
  const t = backend();
  await t.run((ctx) => ctx.db.insert("featureFlags", {
    key: "unified_jurisdictions",
    environment: "test",
    enabled: true,
    updatedAt: Date.now(),
  }));
  const owner = await user(t, "completion-owner");
  const selection = await geographicJurisdiction(t, "Ghana");
  const document = await publishedDocument(
    t,
    selection.jurisdictionId,
    selection.storeName,
  );
  await owner.client.mutation(api.chats.ensure, {
    externalId: "governed-chat",
    jurisdictionId: selection.jurisdictionId,
  });
  const base: CompletionInput = {
    routeNonce: createOpaqueTelemetryToken(),
    externalId: "governed-chat",
    jurisdictionId: selection.jurisdictionId,
    assistantClientId: "assistant-turn-1",
    finalAnswer: "The Constitution supplies the governing rule.",
    answerKind: "legal",
    citations: [{
      jurisdictionId: selection.jurisdictionId,
      resourceId: document.resourceId,
      versionId: document.versionId,
      providerStoreName: selection.storeName,
      pageNumber: 4,
    }],
    model: "gemini-3.5-flash-lite",
    elapsedMs: 125,
    outcome: "success",
    authorizedScopeSize: 1,
    readyStoreCount: 1,
    partialCoverage: false,
    jurisdictionCoverage: [{ ordinal: 0, relation: "selected", coverage: "evidence" }],
  };
  return { t, owner, selection, document, base };
}

async function proofParts(input: CompletionInput): Promise<readonly (string | number)[]> {
  const bindings = await createCitationClaimBindings(
    input.assistantClientId,
    input.finalAnswer ?? "",
    [],
  );
  return [
    "complete-governed-interaction-v2",
    input.routeNonce,
    input.externalId,
    input.jurisdictionId,
    input.answerKind ?? "",
    bindings.assistantClientIdBinding,
    bindings.assistantContentBinding,
    input.model,
    input.elapsedMs,
    input.outcome,
    input.failureCategory ?? "",
    input.authorizedScopeSize,
    input.readyStoreCount,
    input.partialCoverage ? 1 : 0,
    input.jurisdictionCoverage.length,
    ...input.jurisdictionCoverage.flatMap((item) => [
      item.ordinal,
      item.relation,
      item.coverage,
    ]),
    input.citations.length,
    ...input.citations.flatMap((citation) => [
      citation.jurisdictionId,
      citation.resourceId,
      citation.versionId,
      citation.providerStoreName,
      citation.pageNumber ?? 0,
    ]),
    ...(input.diagnostics === undefined ? [] : [
      "query-diagnostics-v1", input.diagnostics.phase, input.diagnostics.reason,
      input.diagnostics.searchCallCount, input.diagnostics.searchResultCount, input.diagnostics.searchResultItemCount,
      input.diagnostics.streamedAnnotationCount, input.diagnostics.canonicalAnnotationCount,
      input.diagnostics.canonicalReadCompleted ? 1 : 0, input.diagnostics.countsClamped ? 1 : 0,
      input.diagnostics.citationUriKind ?? "",
      input.diagnostics.jurisdictionMetadataPresent === undefined ? -1 : input.diagnostics.jurisdictionMetadataPresent ? 1 : 0,
      input.diagnostics.resourceMetadataPresent === undefined ? -1 : input.diagnostics.resourceMetadataPresent ? 1 : 0,
      input.diagnostics.versionMetadataPresent === undefined ? -1 : input.diagnostics.versionMetadataPresent ? 1 : 0,
    ]),
  ];
}

async function complete(client: Client, input: CompletionInput) {
  const normalized = input.outcome === "success" ? input : { ...input, answerKind: undefined };
  const { finalAnswer, failureCategory, answerKind, ...required } = normalized;
  return await client.mutation(completeGovernedInteraction, {
    ...required,
    ...(finalAnswer === undefined ? {} : { finalAnswer }),
    ...(answerKind === undefined ? {} : { answerKind }),
    ...(failureCategory === undefined ? {} : { failureCategory }),
    serviceProof: await createTelemetryServiceProof(await proofParts(normalized)),
  });
}

async function terminalState(t: Backend) {
  return await t.run(async (ctx) => ({
    claims: await ctx.db.query("chatCitationClaims").take(20),
    runs: await ctx.db.query("queryRuns").take(20),
  }));
}

beforeEach(() => {
  process.env.TELEMETRY_INGEST_SECRET = SECRET;
  process.env.ADMIN_ENVIRONMENT = "test";
});

afterEach(() => {
  if (previous.secret === undefined) delete process.env.TELEMETRY_INGEST_SECRET;
  else process.env.TELEMETRY_INGEST_SECRET = previous.secret;
  if (previous.environment === undefined) delete process.env.ADMIN_ENVIRONMENT;
  else process.env.ADMIN_ENVIRONMENT = previous.environment;
});

describe("completeGovernedInteraction", () => {
  it("persists bounded proof-bound query diagnostics without exposing provider content", async () => {
    const { t, owner, base } = await fixture();
    await expect(complete(owner.client, { ...base, diagnostics: TEST_DIAGNOSTICS })).resolves.toMatchObject({ status: "completed" });
    const state = await terminalState(t);
    expect(state.runs[0]).toHaveProperty("diagnostics", TEST_DIAGNOSTICS);
    expect(JSON.stringify(state.runs[0].diagnostics)).not.toContain("fileSearchStores/");
  });

  it("preserves legacy proof parts and completions when diagnostics are absent", async () => {
    const { t, owner, base } = await fixture();
    expect(queryDiagnosticsProofParts()).toEqual([]);
    expect(await completeGovernedInteractionProofParts(base)).toEqual(await proofParts(base));
    await expect(complete(owner.client, base)).resolves.toMatchObject({ status: "completed" });
    expect((await terminalState(t)).runs[0]).not.toHaveProperty("diagnostics");
  });

  it.each(["changed", "added", "removed"])("rejects diagnostics %s after the service proof was signed", async change => {
    const { t, owner, base } = await fixture();
    const signed = { ...base, ...(change === "added" ? {} : { diagnostics: TEST_DIAGNOSTICS }) };
    const sent = { ...base, ...(change === "removed" ? {} : { diagnostics: {
      ...TEST_DIAGNOSTICS, searchResultCount: change === "changed" ? 2 : 1,
    } }) };
    await expect(owner.client.mutation(completeGovernedInteraction, {
      ...sent, serviceProof: await createTelemetryServiceProof(await proofParts(signed)),
    })).rejects.toThrow("GOVERNED_INTERACTION_SERVICE_PROOF_INVALID");
    expect(await terminalState(t)).toEqual({ claims: [], runs: [] });
  });

  it("replays identical diagnostics regardless of key order with the same or a new nonce", async () => {
    const { t, owner, base } = await fixture();
    const input = { ...base, diagnostics: TEST_DIAGNOSTICS };
    await complete(owner.client, input);
    const before = await terminalState(t);
    const reordered = Object.fromEntries(Object.entries(TEST_DIAGNOSTICS).reverse()) as QueryDiagnostics;
    expect(queryDiagnosticsProofParts(reordered)).toEqual(queryDiagnosticsProofParts(TEST_DIAGNOSTICS));
    await expect(complete(owner.client, { ...input, diagnostics: reordered })).resolves.toEqual({ status: "replayed", outcome: "success" });
    await expect(complete(owner.client, { ...input, diagnostics: reordered, routeNonce: createOpaqueTelemetryToken() }))
      .resolves.toEqual({ status: "replayed", outcome: "success" });
    expect(await terminalState(t)).toEqual(before);
  });

  it.each(["same nonce", "new nonce"])("rejects changed diagnostics on signed replay with %s", async nonceKind => {
    const { t, owner, base } = await fixture();
    await complete(owner.client, { ...base, diagnostics: TEST_DIAGNOSTICS });
    const before = await terminalState(t);
    await expect(complete(owner.client, { ...base,
      routeNonce: nonceKind === "new nonce" ? createOpaqueTelemetryToken() : base.routeNonce,
      diagnostics: { ...TEST_DIAGNOSTICS, canonicalAnnotationCount: 2 },
    })).rejects.toThrow(nonceKind === "same nonce" ? "GOVERNED_INTERACTION_REPLAY_INVALID" : "CHAT_CLIENT_ID_CONFLICT");
    expect(await terminalState(t)).toEqual(before);
  });

  it.each(["added", "removed"])("rejects diagnostics %s on a signed legacy-compatible replay", async change => {
    const { t, owner, base } = await fixture();
    await complete(owner.client, { ...base, ...(change === "removed" ? { diagnostics: TEST_DIAGNOSTICS } : {}) });
    const before = await terminalState(t);
    await expect(complete(owner.client, { ...base, ...(change === "added" ? { diagnostics: TEST_DIAGNOSTICS } : {}) }))
      .rejects.toThrow("GOVERNED_INTERACTION_REPLAY_INVALID");
    expect(await terminalState(t)).toEqual(before);
  });

  it.each([
    ["searchCallCount", -1], ["searchResultCount", 1025], ["searchResultItemCount", 0.5],
    ["streamedAnnotationCount", Number.NaN], ["canonicalAnnotationCount", Number.POSITIVE_INFINITY],
    ["version", 2], ["phase", "raw_provider"], ["reason", "arbitrary provider error"],
    ["providerResponse", "private text"], ["citationUriKind", "fileSearchStores/private"],
    ["resourceMetadataPresent", "yes"], ["canonicalReadCompleted", "yes"],
  ])("rejects malformed diagnostic field %s", async (field, value) => {
    const { t, owner, base } = await fixture();
    const diagnostics = { ...TEST_DIAGNOSTICS, [field]: value };
    expect(() => validateQueryDiagnostics(diagnostics)).toThrow("INVALID_QUERY_DIAGNOSTICS");
    await expect(owner.client.mutation(completeGovernedInteraction, {
      ...base, diagnostics, serviceProof: await createTelemetryServiceProof(await proofParts({ ...base, diagnostics: TEST_DIAGNOSTICS })),
    })).rejects.toThrow(/INVALID_QUERY_DIAGNOSTICS|Validator error/);
    expect(await terminalState(t)).toEqual({ claims: [], runs: [] });
  });

  it.each([0, 1024])("accepts diagnostic count boundary %s and omitted optional classifications", async count => {
    const { t, owner, base } = await fixture();
    const diagnostics: QueryDiagnostics = {
      version: 1, phase: "completion", reason: "completed", searchCallCount: count,
      searchResultCount: count, searchResultItemCount: count, streamedAnnotationCount: count, canonicalAnnotationCount: count,
      canonicalReadCompleted: false, countsClamped: count === 1024,
    };
    await complete(owner.client, { ...base, diagnostics });
    expect((await terminalState(t)).runs[0].diagnostics).toEqual(diagnostics);
    expect(queryDiagnosticsProofParts(diagnostics).slice(-4)).toEqual(["", -1, -1, -1]);
  });

  it("records bounded failure diagnostics without creating a citation claim", async () => {
    const { t, owner, base } = await fixture();
    const diagnostics: QueryDiagnostics = { ...TEST_DIAGNOSTICS, reason: "citation_identity", citationUriKind: "other", versionMetadataPresent: false };
    await complete(owner.client, { ...base, finalAnswer: undefined, citations: [], outcome: "failure", failureCategory: "validation",
      jurisdictionCoverage: [{ ordinal: 0, relation: "selected", coverage: "no_evidence" }], diagnostics });
    const state = await terminalState(t);
    expect(state.claims).toEqual([]);
    expect(state.runs[0]).toMatchObject({ outcome: "failure", diagnostics });
  });

  it("persists a fixed policy reply only with its bound kind and claim", async () => {
    const { t, owner, base } = await fixture();
    const finalAnswer = CHAT_POLICY_RESPONSES.out_of_scope;
    const input: CompletionInput = {
      ...base, finalAnswer, answerKind: "policy", citations: [], model: "app-policy-v1",
      authorizedScopeSize: 0, readyStoreCount: 0, partialCoverage: false,
      jurisdictionCoverage: [],
    };
    const result = await complete(owner.client, input);
    expect(result).toMatchObject({ outcome: "success", answerKind: "policy", citations: [] });
    const claim = (result as { citationClaim: string }).citationClaim;
    await expect(owner.client.mutation(api.chats.appendMessages, {
      externalId: base.externalId, lastMessage: finalAnswer,
      messages: [{ role: "assistant", clientId: base.assistantClientId, content: finalAnswer,
        answerKind: "legal", citations: [], citationClaim: claim }],
    })).rejects.toThrow("INVALID_CHAT_CITATION_CLAIM");
    await owner.client.mutation(api.chats.appendMessages, {
      externalId: base.externalId, lastMessage: finalAnswer,
      messages: [{ role: "assistant", clientId: base.assistantClientId, content: finalAnswer,
        answerKind: "policy", citations: [], citationClaim: claim }],
    });
    const page = await owner.client.query(api.chats.listMessages, {
      externalId: base.externalId, paginationOpts: { numItems: 10, cursor: null },
    });
    expect(page.page[0]).toMatchObject({ answerKind: "policy", citations: [] });
    expect((await terminalState(t)).runs[0]).toMatchObject({
      answerKind: "policy", model: "app-policy-v1", citationCount: 0,
      authorizedScopeSize: 1, readyStoreCount: 1,
      jurisdictionCoverage: [{ coverage: "not_searched" }],
    });
  });

  it("rejects a new assistant message without a completion claim", async () => {
    const { owner, base } = await fixture();
    await expect(owner.client.mutation(api.chats.appendMessages, {
      externalId: base.externalId, lastMessage: "unverified",
      messages: [{ role: "assistant", clientId: base.assistantClientId,
        content: "unverified", answerKind: "policy", citations: [] }],
    })).rejects.toThrow("INVALID_CHAT_CITATION_CLAIM");
  });

  it("issues a bound claim for the fixed no-evidence answer and persists it", async () => {
    const { owner, base } = await fixture();
    const finalAnswer = "I couldn't find enough supporting material in this jurisdiction's library to answer. Try asking a more specific legal question.";
    const result = await complete(owner.client, {
      ...base, finalAnswer, citations: [],
      jurisdictionCoverage: [{ ordinal: 0, relation: "selected", coverage: "no_evidence" }],
    });
    expect(result).toMatchObject({ outcome: "success", citations: [], citationClaim: expect.any(String) });
    await owner.client.mutation(api.chats.appendMessages, {
      externalId: base.externalId, lastMessage: finalAnswer,
      messages: [{ role: "assistant", clientId: base.assistantClientId, content: finalAnswer,
        answerKind: "legal", citations: [], citationClaim: (result as { citationClaim: string }).citationClaim }],
    });
    const page = await owner.client.query(api.chats.listMessages, {
      externalId: base.externalId, paginationOpts: { numItems: 10, cursor: null },
    });
    expect(page.page[0]).toMatchObject({ completedAt: expect.any(Number), durationMs: base.elapsedMs });
  });

  it("rejects arbitrary uncited model answers even with a valid service proof", async () => {
    const { owner, base } = await fixture();
    await expect(complete(owner.client, {
      ...base, citations: [],
      jurisdictionCoverage: [{ ordinal: 0, relation: "selected", coverage: "no_evidence" }],
    })).rejects.toThrow("INVALID_GOVERNED_INTERACTION");
  });

  it("atomically validates a published document, derives its label, records safe telemetry, and issues one claim", async () => {
    const { t, owner, selection, base } = await fixture();

    const result = await complete(owner.client, base);

    expect(result).toMatchObject({
      status: "completed",
      outcome: "success",
      partialCoverage: false,
      citations: [{
        label: "Constitution of Ghana, page 4",
        jurisdictionId: selection.jurisdictionId,
        jurisdictionName: "Ghana",
        jurisdictionKind: "geographic",
        relation: "selected",
      }],
      citationClaim: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      expiresAt: expect.any(Number),
    });
    const state = await terminalState(t);
    expect(state.claims).toHaveLength(1);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]).toMatchObject({
      jurisdictionId: selection.jurisdictionId,
      jurisdictionName: "Ghana",
      jurisdictionKind: "geographic",
      outcome: "success",
      model: "gemini-3.5-flash-lite",
      totalLatencyMs: 125,
      authorizedScopeSize: 1,
      readyStoreCount: 1,
      citationCount: 1,
      partialCoverage: false,
    });
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain(base.finalAnswer);
    expect(serialized).not.toContain("fileSearchStores/");
    expect(serialized).not.toContain(String(base.citations[0].resourceId));
    for (const key of [
      "correlationId",
      "contextDigest",
      "searchProviderStatus",
      "generationProviderStatus",
      "plannerStatus",
      "jurisdictionCode",
      "claimNonceHash",
    ]) expect(state.runs[0]).not.toHaveProperty(key);
  }, 30_000);

  it("rejects proof-bound counters that disagree with the current scope", async () => {
    const { t, owner, base } = await fixture();
    const input: CompletionInput = {
      ...base,
      authorizedScopeSize: 2,
      readyStoreCount: 2,
      jurisdictionCoverage: [
        { ordinal: 0, relation: "selected", coverage: "evidence" },
        { ordinal: 1, relation: "geographic_ancestor", coverage: "no_evidence" },
      ],
    };

    await expect(complete(owner.client, input)).rejects.toThrow(
      "INVALID_GOVERNED_INTERACTION",
    );
    expect(await terminalState(t)).toEqual({ claims: [], runs: [] });
  });

  it("rejects scope metadata after a supplementary store becomes unready", async () => {
    const { t, owner, selection, base } = await fixture();
    const parent = await attachReadyParent(t, selection.jurisdictionId);
    const input: CompletionInput = {
      ...base,
      authorizedScopeSize: 2,
      readyStoreCount: 2,
      jurisdictionCoverage: [
        { ordinal: 0, relation: "selected", coverage: "evidence" },
        { ordinal: 1, relation: "geographic_ancestor", coverage: "no_evidence" },
      ],
    };
    await t.run((ctx) => ctx.db.patch(parent.jurisdictionId, {
      providerSyncState: "drifted",
      updatedAt: Date.now(),
    }));

    await expect(complete(owner.client, input)).rejects.toThrow(
      "INVALID_GOVERNED_INTERACTION",
    );
    expect(await terminalState(t)).toEqual({ claims: [], runs: [] });
  });

  it("rejects a proof-bound coverage relation that disagrees with current store order", async () => {
    const { t, owner, selection, base } = await fixture();
    await attachReadyParent(t, selection.jurisdictionId);
    const input: CompletionInput = {
      ...base,
      authorizedScopeSize: 2,
      readyStoreCount: 2,
      jurisdictionCoverage: [
        { ordinal: 0, relation: "selected", coverage: "evidence" },
        { ordinal: 1, relation: "organizational_geography", coverage: "no_evidence" },
      ],
    };

    await expect(complete(owner.client, input)).rejects.toThrow(
      "INVALID_GOVERNED_INTERACTION",
    );
    expect(await terminalState(t)).toEqual({ claims: [], runs: [] });
  });

  it("makes nonce and exact assistant-client retries write-idempotent without reissuing a claim", async () => {
    const { t, owner, base } = await fixture();
    const first = await complete(owner.client, base);
    expect(first.status).toBe("completed");

    await expect(complete(owner.client, base)).resolves.toEqual({
      status: "replayed",
      outcome: "success",
    });
    await expect(complete(owner.client, {
      ...base,
      routeNonce: createOpaqueTelemetryToken(),
    })).resolves.toEqual({
      status: "replayed",
      outcome: "success",
    });
    const state = await terminalState(t);
    expect(state.runs).toHaveLength(1);
    expect(state.claims).toHaveLength(1);
  });

  it("rejects conflicting reuse of an assistant client ID without writing", async () => {
    const { t, owner, base } = await fixture();
    await complete(owner.client, base);
    const conflicting = {
      ...base,
      routeNonce: createOpaqueTelemetryToken(),
      finalAnswer: "A different answer.",
    };

    await expect(complete(owner.client, conflicting)).rejects.toThrow(
      "CHAT_CLIENT_ID_CONFLICT",
    );
    const state = await terminalState(t);
    expect(state.runs).toHaveLength(1);
    expect(state.claims).toHaveLength(1);
  });

  it.each(["bad nonce", "bad proof"] as const)(
    "rejects a %s before any terminal write",
    async (kind) => {
      const { t, owner, base } = await fixture();
      const input = kind === "bad nonce" ? { ...base, routeNonce: "not-a-nonce" } : base;
      const serviceProof = kind === "bad proof"
        ? "x".repeat(43)
        : await createTelemetryServiceProof(await proofParts(input));

      await expect(owner.client.mutation(completeGovernedInteraction, {
        ...input,
        serviceProof,
      })).rejects.toThrow();
      expect(await terminalState(t)).toEqual({ claims: [], runs: [] });
    },
  );

  it("rejects a non-owner without disclosing the chat and writes nothing", async () => {
    const { t, base } = await fixture();
    const outsider = await user(t, "completion-outsider");

    await expect(complete(outsider.client, base)).rejects.toThrow();
    expect(await terminalState(t)).toEqual({ claims: [], runs: [] });
  });

  it.each(["invalid identity", "outside scope"] as const)(
    "rejects a citation with %s without a claim or success telemetry",
    async (kind) => {
      const { t, owner, base } = await fixture();
      let citation: CitationIdentity;
      if (kind === "invalid identity") {
        citation = { ...base.citations[0], resourceId: "not-a-convex-id" };
      } else {
        const other = await geographicJurisdiction(t, "Nigeria");
        const document = await publishedDocument(t, other.jurisdictionId, other.storeName, "Nigeria Act");
        citation = {
          jurisdictionId: other.jurisdictionId,
          resourceId: document.resourceId,
          versionId: document.versionId,
          providerStoreName: other.storeName,
        };
      }
      const input = {
        ...base,
        citations: [citation],
      };

      await expect(complete(owner.client, input)).rejects.toThrow("INVALID_CHAT_CITATIONS");
      expect(await terminalState(t)).toEqual({ claims: [], runs: [] });
    },
  );

  it.each(["inactive", "unpublished", "changed document", "locked"] as const)(
    "rejects a citation whose current manifest is %s",
    async (state) => {
      const { t, owner, document, base } = await fixture();
      await t.run(async (ctx) => {
        if (state === "inactive") await ctx.db.patch(document.resourceId, { status: "archived" });
        if (state === "unpublished") await ctx.db.patch(document.versionId, { status: "unpublished" });
        if (state === "changed document") {
          await ctx.db.patch(document.versionId, {
            geminiDocumentName: "fileSearchStores/other/documents/constitution",
          });
        }
        if (state === "locked") {
          await ctx.db.insert("documentLifecycleLocks", {
            resourceId: document.resourceId,
            versionId: document.versionId,
            operation: "unpublish",
            actorId: "fixture",
            idempotencyKey: "completion-lock",
            expiresAt: Date.now() + 60_000,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
      });

      await expect(complete(owner.client, base)).rejects.toThrow("INVALID_CHAT_CITATIONS");
      expect(await terminalState(t)).toEqual({ claims: [], runs: [] });
    },
  );

  it("rejects a citation naming a store different from the current resolved store", async () => {
    const { t, owner, base } = await fixture();
    const input: CompletionInput = {
      ...base,
      citations: [{
        ...base.citations[0],
        providerStoreName: "fileSearchStores/wrong-store",
      }],
    };

    await expect(complete(owner.client, input)).rejects.toThrow("INVALID_CHAT_CITATIONS");
    expect(await terminalState(t)).toEqual({ claims: [], runs: [] });
  });

  it.each([
    ["failure", "network"],
    ["aborted", undefined],
  ] as const)("records safe %s terminal telemetry without a claim", async (outcome, failureCategory) => {
    const { t, owner, base } = await fixture();
    const input: CompletionInput = {
      ...base,
      routeNonce: createOpaqueTelemetryToken(),
      finalAnswer: undefined,
      citations: [],
      outcome,
      ...(failureCategory ? { failureCategory } : {}),
      jurisdictionCoverage: [{ ordinal: 0, relation: "selected", coverage: "no_evidence" }],
    };

    const result = await complete(owner.client, input);

    expect(result).toEqual({ status: "completed", outcome });
    const state = await terminalState(t);
    expect(state.claims).toEqual([]);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]).toMatchObject({ outcome, citationCount: 0 });
    if (failureCategory) expect(state.runs[0]).toHaveProperty("failureCategory", failureCategory);
    else expect(state.runs[0]).not.toHaveProperty("failureCategory");
  });

  it.each([
    ["failure", "network"],
    ["aborted", undefined],
  ] as const)("records claim-free %s telemetry after the ready-store manifest drifts", async (outcome, failureCategory) => {
    const { t, owner, selection, base } = await fixture();
    await t.run((ctx) => ctx.db.patch(selection.jurisdictionId, {
      providerSyncState: "drifted",
      updatedAt: Date.now(),
    }));
    if (outcome === "failure") {
      await expect(complete(owner.client, base)).rejects.toThrow(
        "CHAT_RESEARCH_STORE_NOT_READY",
      );
    }
    const input: CompletionInput = {
      ...base,
      finalAnswer: undefined,
      citations: [],
      outcome,
      ...(failureCategory ? { failureCategory } : {}),
      jurisdictionCoverage: [{ ordinal: 0, relation: "selected", coverage: "no_evidence" }],
    };

    await expect(complete(owner.client, input)).resolves.toEqual({
      status: "completed",
      outcome,
    });
    const state = await terminalState(t);
    expect(state.claims).toEqual([]);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]).toMatchObject({
      outcome,
      authorizedScopeSize: 1,
      readyStoreCount: 1,
      citationCount: 0,
      partialCoverage: false,
      jurisdictionCoverage: [
        { ordinal: 0, relation: "selected", coverage: "no_evidence" },
      ],
    });
    if (failureCategory) expect(state.runs[0]).toHaveProperty("failureCategory", failureCategory);
    else expect(state.runs[0]).not.toHaveProperty("failureCategory");
  });
});
