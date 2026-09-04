/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { completeGovernedInteractionProofParts, normalizePageSize } from "./chats";
import authSchema from "./betterAuth/schema";
import { citationClaimIssueProofParts } from "./lib/chatCitationClaim";
import { createOpaqueTelemetryToken, createTelemetryServiceProof } from "./lib/telemetryProof";
import { resolveLegacyJurisdictionSnapshot } from "./lib/legacyJurisdictionCompatibility";
import schema from "./schema";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.ts")).map(([path, load]) => [path, load]),
);
const authModules = Object.fromEntries(
  Object.entries(import.meta.glob("./betterAuth/**/*.ts")).map(
    ([path, load]) => [`./${path.slice("./betterAuth/".length)}`, load],
  ),
);

function createTestBackend() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  return t;
}

const previousAdminEnvironment = process.env.ADMIN_ENVIRONMENT;
const previousTelemetrySecret = process.env.TELEMETRY_INGEST_SECRET;
const CLAIM_SECRET = "chat-claim-test-secret-with-at-least-32-characters";

const completeGovernedInteraction = makeFunctionReference<"mutation">(
  "chats:completeGovernedInteraction",
);

type Citation = {
  label: string;
  jurisdictionId: Id<"jurisdictions">;
  jurisdictionName: string;
  jurisdictionKind: "geographic" | "organizational";
  relation: "selected" | "geographic_ancestor" | "organizational_geography";
};

async function issueClaim(
  t: TestConvex<typeof schema>,
  client: ReturnType<TestConvex<typeof schema>["withIdentity"]>,
  input: { externalId: string; jurisdictionId: Id<"jurisdictions">; clientId: string; content: string; citations: Citation[] },
) {
  const routeNonce = createOpaqueTelemetryToken();
  const citationIds = await t.run(async (ctx) => {
    const uniqueJurisdictionIds = new Set<Id<"jurisdictions">>([
      input.jurisdictionId,
      ...input.citations.map((citation) => citation.jurisdictionId),
    ]);
    const stores = new Map<Id<"jurisdictions">, string>();
    for (const jurisdictionId of uniqueJurisdictionIds) {
      const storeName = `fileSearchStores/${crypto.randomUUID()}`;
      await ctx.db.patch(jurisdictionId, {
        geminiFileSearchStoreName: storeName,
        geminiEmbeddingModel: "models/gemini-embedding-2",
        providerSyncState: "synced",
        updatedAt: Date.now(),
      });
      stores.set(jurisdictionId, storeName);
    }
    const identities = [];
    for (const citation of input.citations) {
      const now = Date.now();
      const originalStorageId = await ctx.storage.store(new Blob(["law"]));
      const resourceId = await ctx.db.insert("legalResources", {
        jurisdictionId: citation.jurisdictionId,
        type: "constitution",
        title: citation.label,
        issuer: "Fixture issuer",
        officialCitation: `Fixture ${crypto.randomUUID()}`,
        officialCitationKey: `fixture-${crypto.randomUUID()}`,
        sourceUrl: "https://official.example/law",
        topics: ["law"],
        effectiveDate: "2026-01-01",
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
        filename: "fixture.pdf",
        mimeType: "application/pdf",
        byteSize: 3,
        sha256: "a".repeat(64),
        sourceUrl: "https://official.example/law",
        status: "published",
        geminiDocumentName: `${stores.get(citation.jurisdictionId)!}/documents/${crypto.randomUUID()}`,
        submittedBy: "fixture",
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(resourceId, { activeVersionId: versionId });
      identities.push({
        jurisdictionId: citation.jurisdictionId,
        resourceId,
        versionId,
      });
    }
    return { identities, readyStoreCount: uniqueJurisdictionIds.size };
  });
  const completion = {
    routeNonce,
    externalId: input.externalId,
    jurisdictionId: input.jurisdictionId,
    assistantClientId: input.clientId,
    finalAnswer: input.content,
    citations: citationIds.identities,
    model: "gemini-3.5-flash-lite",
    elapsedMs: 1,
    outcome: "success" as const,
    authorizedScopeSize: citationIds.readyStoreCount,
    readyStoreCount: citationIds.readyStoreCount,
    partialCoverage: false,
    jurisdictionCoverage: Array.from({ length: citationIds.readyStoreCount }, (_, ordinal) => ({
      ordinal,
      relation: ordinal === 0 ? "selected" as const : "geographic_ancestor" as const,
      coverage: "evidence" as const,
    })),
  };
  const result = await client.mutation(completeGovernedInteraction, {
    ...completion,
    serviceProof: await createTelemetryServiceProof(
      await completeGovernedInteractionProofParts(completion),
    ),
  });
  if (result.status !== "completed" || result.outcome !== "success") {
    throw new Error("Expected completed governed interaction");
  }
  return result;
}

afterEach(() => {
  if (previousAdminEnvironment === undefined) delete process.env.ADMIN_ENVIRONMENT;
  else process.env.ADMIN_ENVIRONMENT = previousAdminEnvironment;
  if (previousTelemetrySecret === undefined) delete process.env.TELEMETRY_INGEST_SECRET;
  else process.env.TELEMETRY_INGEST_SECRET = previousTelemetrySecret;
});

async function enableUnifiedJurisdictions(t: TestConvex<typeof schema>) {
  process.env.ADMIN_ENVIRONMENT = "test";
  await t.run((ctx) => ctx.db.insert("featureFlags", {
    key: "unified_jurisdictions",
    environment: "test",
    enabled: true,
    updatedAt: Date.now(),
  }));
}

async function createGeographicJurisdiction(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const id = await ctx.db.insert("jurisdictions", {
      name: "Ghana",
      slug: "ghana",
      status: "enabled",
      isDefault: true,
      providerSyncState: "synced",
      kind: "geographic",
      visibility: "public",
      legacyCountryCode: "GH",
      createdBy: "fixture",
      updatedBy: "fixture",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("geographicJurisdictions", {
      jurisdictionId: id,
      googlePlaceId: "place-ghana",
      level: "country",
      countryCode: "GH",
      latitude: 7.9465,
      longitude: -1.0232,
      formattedAddress: "Ghana",
      createdAt: now,
      updatedAt: now,
    });
    return id;
  });
}

async function createUser(t: TestConvex<typeof schema>, email: string) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const user = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          name: "Chat pagination test",
          email,
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
          userId: user._id,
          expiresAt: now + 86_400_000,
          createdAt: now,
          updatedAt: now,
        },
      },
    });
    return { userId: user._id, sessionId: session._id };
  });
}

describe("chat pagination", () => {
  it.each([
    "disabled",
    "ghana-shadow",
    "non-ghana-shadow",
    "duplicate-default",
    "provider",
    "visibility",
    "kind-without-profile",
    "partial-profile",
    "organization-link",
    "locality-profile",
    "non-root-profile",
    "profile-code-mismatch",
  ] as const)("rejects the %s legacy compatibility boundary", async (variant) => {
    const t = createTestBackend();
    await t.run(async (ctx) => {
      const now = Date.now();
      const insertCommon = async (input: {
        code?: string;
        legacyCountryCode?: string;
        status?: "draft" | "enabled" | "archived";
        isDefault?: boolean;
        geminiFileSearchStoreName?: string;
        providerSyncState?: "pending" | "synced" | "drifted" | "failed";
        kind?: "geographic" | "organizational";
        visibility?: "public" | "members";
        organizationId?: Id<"organizations">;
        slug: string;
      }) => await ctx.db.insert("jurisdictions", {
        ...(input.code ? { code: input.code } : {}),
        ...(input.legacyCountryCode ? { legacyCountryCode: input.legacyCountryCode } : {}),
        name: input.slug,
        slug: input.slug,
        status: input.status ?? "enabled",
        isDefault: input.isDefault ?? false,
        geminiFileSearchStoreName: input.geminiFileSearchStoreName
          ?? `fileSearchStores/${input.slug}`,
        geminiEmbeddingModel: "models/gemini-embedding-2",
        providerSyncState: input.providerSyncState ?? "synced",
        kind: input.kind,
        visibility: input.visibility,
        organizationId: input.organizationId,
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
      const insertProfile = async (
        jurisdictionId: Id<"jurisdictions">,
        input: { level?: "country" | "state" | "province" | "region" | "district" | "city" | "town" | "territory" | "other_locality"; countryCode?: string; parentJurisdictionId?: Id<"jurisdictions"> } = {},
      ) => await ctx.db.insert("geographicJurisdictions", {
        jurisdictionId,
        googlePlaceId: `place-${variant}`,
        level: input.level ?? "country",
        countryCode: input.countryCode ?? "GH",
        latitude: 0,
        longitude: 0,
        formattedAddress: variant,
        parentJurisdictionId: input.parentJurisdictionId,
        createdAt: now,
        updatedAt: now,
      });

      if (variant === "disabled") {
        const id = await insertCommon({ slug: variant, legacyCountryCode: "GH", status: "archived", kind: "geographic", visibility: "public" });
        await insertProfile(id);
        return;
      }
      if (variant === "ghana-shadow" || variant === "non-ghana-shadow") {
        const code = variant === "ghana-shadow" ? "GH" : "NG";
        const id = await insertCommon({ slug: `${variant}-canonical`, legacyCountryCode: code, kind: "geographic", visibility: "public" });
        await insertProfile(id, { countryCode: code });
        await insertCommon({ slug: `${variant}-shadow`, code });
        return;
      }
      if (variant === "duplicate-default") {
        await insertCommon({ slug: "default-one", code: "GH", isDefault: true });
        await insertCommon({ slug: "default-two", code: "GH", isDefault: true });
        return;
      }
      if (["provider", "visibility"].includes(variant)) {
        await insertCommon({
          slug: variant,
          code: "GH",
          isDefault: true,
          providerSyncState: variant === "provider" ? "drifted" : "synced",
          visibility: variant === "visibility" ? "members" : undefined,
        });
        return;
      }
      if (variant === "organization-link") {
        const organizationId = await ctx.db.insert("organizations", {
          name: "Wrong organization", slug: "wrong-organization", class: "company",
          status: "active", createdBy: "fixture", updatedBy: "fixture", createdAt: now, updatedAt: now,
        });
        await insertCommon({ slug: variant, code: "GH", isDefault: true, organizationId });
        return;
      }
      const id = await insertCommon({
        slug: variant,
        legacyCountryCode: "GH",
        kind: variant === "partial-profile" ? undefined : "geographic",
        visibility: "public",
      });
      if (variant !== "kind-without-profile") {
        let parentJurisdictionId: Id<"jurisdictions"> | undefined;
        if (variant === "non-root-profile") {
          parentJurisdictionId = await insertCommon({ slug: "parent", legacyCountryCode: "NG", kind: "geographic", visibility: "public" });
        }
        await insertProfile(id, {
          level: variant === "locality-profile" ? "town" : "country",
          countryCode: variant === "profile-code-mismatch" ? "NG" : "GH",
          parentJurisdictionId,
        });
      }
    });

    const suppliedCountry = variant === "non-ghana-shadow" ? "NG" :
      variant === "duplicate-default" ? undefined : "GH";
    await expect(t.run((ctx) =>
      resolveLegacyJurisdictionSnapshot(ctx, suppliedCountry),
    )).resolves.toBeNull();
  });

  it("dual-writes a stable legacy snapshot while flag-off chat behavior stays writable", async () => {
    const t = createTestBackend();
    process.env.ADMIN_ENVIRONMENT = "test";
    const owner = await createUser(t, `legacy-chat-${crypto.randomUUID()}@example.com`);
    const jurisdictionId = await createGeographicJurisdiction(t);
    const client = t.withIdentity({ subject: owner.userId, sessionId: owner.sessionId });

    await client.mutation(api.chats.ensure, { externalId: "legacy-dual-write", country: "GH" });
    await t.run((ctx) => ctx.db.patch(jurisdictionId, {
      name: "Republic of Ghana",
      updatedAt: Date.now(),
    }));
    await client.mutation(api.chats.appendMessages, {
      externalId: "legacy-dual-write",
      lastMessage: "Legacy remains writable",
      messages: [{ role: "user", content: "Legacy remains writable", clientId: "legacy-message" }],
    });
    const flagId = await t.run((ctx) => ctx.db.insert("featureFlags", {
      key: "unified_jurisdictions",
      environment: "test",
      enabled: true,
      updatedAt: Date.now(),
    }));
    await client.mutation(api.chats.appendMessages, {
      externalId: "legacy-dual-write", jurisdictionId,
      lastMessage: "Governed while enabled",
      messages: [{ role: "user", content: "Governed while enabled", clientId: "enabled-message" }],
    });
    await t.run((ctx) => ctx.db.patch(flagId, { enabled: false, updatedAt: Date.now() }));
    await client.mutation(api.chats.appendMessages, {
      externalId: "legacy-dual-write",
      lastMessage: "Writable after rollback",
      messages: [{ role: "user", content: "Writable after rollback", clientId: "rollback-message" }],
    });

    const snapshot = await t.run(async (ctx) => ({
      session: await ctx.db.query("chatSessions")
        .withIndex("by_user_externalId", (q) =>
          q.eq("userId", owner.userId).eq("externalId", "legacy-dual-write"))
        .unique(),
      messages: await ctx.db.query("messages").take(4),
    }));
    expect(snapshot.session).toMatchObject({
      country: "GH", jurisdictionId, jurisdictionName: "Ghana",
      jurisdictionKind: "geographic", jurisdictionContract: "legacy",
      messageCount: 3, lastMessage: "Writable after rollback",
    });
    expect(snapshot.messages.map((row) => row.content)).toEqual([
      "Legacy remains writable",
      "Governed while enabled",
      "Writable after rollback",
    ]);
    expect(snapshot.messages).toHaveLength(3);
  });

  it("fails closed before flag-off chat insertion when the legacy mapping is ambiguous", async () => {
    const t = createTestBackend();
    process.env.ADMIN_ENVIRONMENT = "test";
    const owner = await createUser(t, `ambiguous-chat-${crypto.randomUUID()}@example.com`);
    await createGeographicJurisdiction(t);
    await t.run(async (ctx) => {
      const now = Date.now();
      const duplicateId = await ctx.db.insert("jurisdictions", {
        name: "Duplicate Ghana", slug: "duplicate-ghana", status: "enabled",
        isDefault: false, providerSyncState: "synced", kind: "geographic",
        visibility: "public", legacyCountryCode: "GH", createdBy: "fixture",
        updatedBy: "fixture", createdAt: now, updatedAt: now,
      });
      await ctx.db.insert("geographicJurisdictions", {
        jurisdictionId: duplicateId, googlePlaceId: "duplicate-place-ghana",
        level: "country", countryCode: "GH", latitude: 0, longitude: 0,
        formattedAddress: "Duplicate Ghana", createdAt: now, updatedAt: now,
      });
    });
    const client = t.withIdentity({ subject: owner.userId, sessionId: owner.sessionId });

    await expect(client.mutation(api.chats.ensure, {
      externalId: "ambiguous-legacy", country: "GH",
    })).rejects.toThrow("That jurisdiction is not available");
    await expect(t.run((ctx) => ctx.db.query("chatSessions").take(2))).resolves.toEqual([]);
  });

  it("fails closed on an explicit legacy ID session missing its immutable country snapshot", async () => {
    const t = createTestBackend();
    process.env.ADMIN_ENVIRONMENT = "test";
    const owner = await createUser(t, `corrupt-legacy-${crypto.randomUUID()}@example.com`);
    const jurisdictionId = await createGeographicJurisdiction(t);
    await t.run((ctx) => ctx.db.insert("chatSessions", {
      userId: owner.userId,
      externalId: "corrupt-legacy",
      title: "Corrupt legacy",
      lastMessage: "",
      messageCount: 0,
      updatedAt: 1,
      jurisdictionId,
      jurisdictionName: "Ghana",
      jurisdictionKind: "geographic",
      jurisdictionContract: "legacy",
    }));
    const client = t.withIdentity({ subject: owner.userId, sessionId: owner.sessionId });

    await expect(client.query(api.chats.getByExternalId, { externalId: "corrupt-legacy" }))
      .resolves.toBeNull();
    await expect(client.mutation(api.chats.appendMessages, {
      externalId: "corrupt-legacy",
      lastMessage: "Must not save",
      messages: [{ role: "user", content: "Must not save", clientId: "blocked" }],
    })).rejects.toThrow("That jurisdiction is not available");
  });

  it("fails closed at every chat boundary for an explicit unified session missing its stable ID", async () => {
    const t = createTestBackend();
    process.env.ADMIN_ENVIRONMENT = "test";
    const owner = await createUser(t, `corrupt-unified-${crypto.randomUUID()}@example.com`);
    await t.run((ctx) => ctx.db.insert("chatSessions", {
      userId: owner.userId,
      externalId: "corrupt-unified",
      title: "Corrupt unified",
      lastMessage: "Must stay hidden",
      messageCount: 0,
      updatedAt: 1,
      country: "GH",
      jurisdictionName: "Ghana",
      jurisdictionKind: "geographic",
      jurisdictionContract: "unified",
    }));
    const client = t.withIdentity({ subject: owner.userId, sessionId: owner.sessionId });

    await expect(client.query(api.chats.list, {
      paginationOpts: { numItems: 10, cursor: null },
    })).resolves.toMatchObject({ page: [] });
    await expect(client.query(api.chats.getByExternalId, { externalId: "corrupt-unified" }))
      .resolves.toBeNull();
    await expect(client.query(api.chats.listMessages, {
      externalId: "corrupt-unified",
      paginationOpts: { numItems: 10, cursor: null },
    })).resolves.toMatchObject({ page: [] });
    await expect(client.mutation(api.chats.ensure, {
      externalId: "corrupt-unified", country: "GH",
    })).rejects.toThrow("That jurisdiction is not available");
    await expect(client.mutation(api.chats.appendMessages, {
      externalId: "corrupt-unified", lastMessage: "Must not write",
      messages: [{ role: "user", content: "Must not write", clientId: "blocked" }],
    })).rejects.toThrow("That jurisdiction is not available");
  });

  it("uses the narrow pre-V2 Ghana default for omitted-country ensure and local migration", async () => {
    const t = createTestBackend();
    process.env.ADMIN_ENVIRONMENT = "test";
    const owner = await createUser(t, `default-chat-${crypto.randomUUID()}@example.com`);
    const jurisdictionId = await t.run((ctx) => {
      const now = Date.now();
      return ctx.db.insert("jurisdictions", {
        code: "GH", name: "Ghana", slug: "ghana-v1", status: "enabled",
        isDefault: true, geminiFileSearchStoreName: "fileSearchStores/ghana-v1",
        geminiEmbeddingModel: "models/gemini-embedding-2", providerSyncState: "synced",
        createdBy: "migration:seed-ghana-jurisdiction-v1",
        updatedBy: "migration:seed-ghana-jurisdiction-v1", createdAt: now, updatedAt: now,
      });
    });
    const client = t.withIdentity({ subject: owner.userId, sessionId: owner.sessionId });

    await client.mutation(api.chats.ensure, { externalId: "default-ensure" });
    await expect(client.mutation(api.chats.migrateFromLocal, {
      sessions: [{
        externalId: "default-migration", title: "Migrated", lastMessage: "Local",
        messageCount: 1, updatedAt: 123,
        messages: [{ role: "user", content: "Local", clientId: "local-message", createdAt: 123 }],
      }],
    })).resolves.toEqual({ migratedCount: 1 });

    const rows = await t.run((ctx) => ctx.db.query("chatSessions").take(3));
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        externalId: "default-ensure", country: "GH", jurisdictionId,
        jurisdictionName: "Ghana", jurisdictionKind: "geographic",
        jurisdictionContract: "legacy",
      }),
      expect.objectContaining({
        externalId: "default-migration", country: "GH", jurisdictionId,
        jurisdictionName: "Ghana", jurisdictionKind: "geographic",
        jurisdictionContract: "legacy",
      }),
    ]));
  });

  it("resolves no default when local migration is empty or every session already exists", async () => {
    const t = createTestBackend();
    const owner = await createUser(t, `lazy-migration-${crypto.randomUUID()}@example.com`);
    await t.run((ctx) => ctx.db.insert("chatSessions", {
      userId: owner.userId,
      externalId: "already-present",
      title: "Existing",
      lastMessage: "",
      messageCount: 0,
      updatedAt: 1,
    }));
    const client = t.withIdentity({ subject: owner.userId, sessionId: owner.sessionId });
    await expect(client.mutation(api.chats.migrateFromLocal, { sessions: [] }))
      .resolves.toEqual({ migratedCount: 0 });
    await expect(client.mutation(api.chats.migrateFromLocal, {
      sessions: [{
        externalId: "already-present", title: "Ignored", lastMessage: "Ignored",
        messageCount: 1, updatedAt: 2, messages: [{ role: "user", content: "Ignored" }],
      }],
    })).resolves.toEqual({ migratedCount: 0 });
  });

  it("stores an authorized stable jurisdiction snapshot and keeps it immutable after rename", async () => {
    const t = createTestBackend();
    await enableUnifiedJurisdictions(t);
    const owner = await createUser(t, `chat-owner-${crypto.randomUUID()}@example.com`);
    const jurisdictionId = await createGeographicJurisdiction(t);
    const client = t.withIdentity({ subject: owner.userId, sessionId: owner.sessionId });

    await client.mutation(api.chats.ensure, {
      externalId: "stable-jurisdiction",
      jurisdictionId,
      jurisdictionName: "Ghana",
      jurisdictionKind: "geographic",
      country: "GH",
    });
    await expect(t.run((ctx) => ctx.db.query("chatSessions").take(1)))
      .resolves.toMatchObject([{ jurisdictionContract: "unified" }]);
    await t.run((ctx) => ctx.db.patch(jurisdictionId, { name: "Republic of Ghana" }));

    await expect(client.query(api.chats.getByExternalId, {
      externalId: "stable-jurisdiction",
    })).resolves.toMatchObject({
      jurisdictionId,
      jurisdictionName: "Ghana",
      jurisdictionKind: "geographic",
      country: "GH",
    });
  });

  it("rejects a malformed stable jurisdiction with the uniform unavailable error before insert", async () => {
    const t = createTestBackend();
    await enableUnifiedJurisdictions(t);
    const owner = await createUser(t, `chat-owner-${crypto.randomUUID()}@example.com`);
    const client = t.withIdentity({ subject: owner.userId, sessionId: owner.sessionId });
    await expect(client.mutation(api.chats.ensure, {
      externalId: "malformed-jurisdiction",
      jurisdictionId: "not-a-convex-id",
    })).rejects.toThrow("That jurisdiction is not available for research");
    const rows = await t.run((ctx) => ctx.db.query("chatSessions")
      .withIndex("by_user_externalId", (q) => q.eq("userId", owner.userId).eq("externalId", "malformed-jurisdiction"))
      .take(1));
    expect(rows).toEqual([]);
  });

  it("round-trips only assistant citation snapshots in their original order", async () => {
    const t = createTestBackend();
    process.env.TELEMETRY_INGEST_SECRET = CLAIM_SECRET;
    await enableUnifiedJurisdictions(t);
    const owner = await createUser(t, `chat-owner-${crypto.randomUUID()}@example.com`);
    const jurisdictionId = await createGeographicJurisdiction(t);
    const client = t.withIdentity({ subject: owner.userId, sessionId: owner.sessionId });
    await client.mutation(api.chats.ensure, { externalId: "cited", jurisdictionId });
    const citations = [{
      label: "Constitution, article 1",
      jurisdictionId,
      jurisdictionName: "Ghana",
      jurisdictionKind: "geographic" as const,
      relation: "selected" as const,
    }];
    const claim = await issueClaim(t, client, {
      externalId: "cited",
      jurisdictionId,
      clientId: "cited-answer",
      content: "Answer",
      citations,
    });
    await client.mutation(api.chats.appendMessages, {
      externalId: "cited",
      lastMessage: "Answer",
      jurisdictionId,
      messages: [{ role: "assistant", content: "Answer", clientId: "cited-answer", citations, citationClaim: claim.citationClaim }],
    });
    const page = await client.query(api.chats.listMessages, {
      externalId: "cited",
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(page.page[0].citations).toEqual(citations);
    await t.run((ctx) => ctx.db.patch(jurisdictionId, { name: "Republic of Ghana" }));
    await expect(client.mutation(api.chats.appendMessages, {
      externalId: "cited",
      lastMessage: "Answer",
      jurisdictionId,
      messages: [{ role: "assistant", content: "Answer", clientId: "cited-answer", citations, citationClaim: claim.citationClaim }],
    })).resolves.toEqual({ id: "cited" });
    await expect(client.mutation(api.chats.appendMessages, {
      externalId: "cited",
      lastMessage: "Forged metadata",
      jurisdictionId,
      messages: [{ role: "assistant", content: "Forged answer", clientId: "cited-answer", citations, citationClaim: claim.citationClaim }],
    })).rejects.toThrow("CHAT_CLIENT_ID_CONFLICT");
    await expect(client.query(api.chats.getByExternalId, { externalId: "cited" }))
      .resolves.toMatchObject({ lastMessage: "Answer", messageCount: 1 });

    await expect(client.mutation(api.chats.appendMessages, {
      externalId: "cited",
      lastMessage: "Invalid",
      jurisdictionId,
      messages: [{ role: "user", content: "Question", citations }],
    } as never)).rejects.toThrow();
    const unchanged = await client.query(api.chats.listMessages, {
      externalId: "cited",
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(unchanged.page.map((message) => message.content)).toEqual(["Answer"]);
  });

  it("binds a one-use citation claim to exact owner, session, chat, client, content, and ordered DTO", async () => {
    const t = createTestBackend();
    process.env.TELEMETRY_INGEST_SECRET = CLAIM_SECRET;
    await enableUnifiedJurisdictions(t);
    const owner = await createUser(t, `claim-owner-${crypto.randomUUID()}@example.com`);
    const jurisdictionId = await createGeographicJurisdiction(t);
    const client = t.withIdentity({ subject: owner.userId, sessionId: owner.sessionId });
    await client.mutation(api.chats.ensure, { externalId: "claim-chat", jurisdictionId });
    const citations = [{
      label: "Constitution, article 1",
      jurisdictionId,
      jurisdictionName: "Ghana",
      jurisdictionKind: "geographic" as const,
      relation: "selected" as const,
    }];
    const claim = await issueClaim(t, client, {
      externalId: "claim-chat", jurisdictionId, clientId: "assistant-1", content: "Bound answer", citations,
    });

    const rawClaims = await t.run((ctx) => ctx.db.query("chatCitationClaims").take(2));
    expect(rawClaims).toHaveLength(1);
    expect(JSON.stringify(rawClaims)).not.toMatch(/Bound answer|Constitution|article 1|assistant-1/);
    const runs = await t.run((ctx) => ctx.db.query("queryRuns").take(2));
    expect(runs).toHaveLength(1);
    expect(JSON.stringify(runs)).not.toMatch(/Bound answer|Constitution|article 1|assistant-1/);

    await client.mutation(api.chats.appendMessages, {
      externalId: "claim-chat", jurisdictionId, lastMessage: "Bound answer",
      messages: [{
        role: "assistant", content: "Bound answer", clientId: "assistant-1",
        citations, citationClaim: claim.citationClaim,
      }],
    });
    expect(await t.run((ctx) => ctx.db.query("chatCitationClaims").take(2))).toEqual([]);

    await expect(client.mutation(api.chats.appendMessages, {
      externalId: "claim-chat", jurisdictionId, lastMessage: "Replay",
      messages: [{
        role: "assistant", content: "Bound answer", clientId: "assistant-replay",
        citations, citationClaim: claim.citationClaim,
      }],
    })).rejects.toThrow("INVALID_CHAT_CITATION_CLAIM");
    const messages = await client.query(api.chats.listMessages, {
      externalId: "claim-chat", paginationOpts: { numItems: 20, cursor: null },
    });
    expect(messages.page.map((message) => message.content)).toEqual(["Bound answer"]);
  });

  it.each(["assistant content", "citation label"] as const)(
    "distinguishes a lone surrogate from its replacement character in %s bindings",
    async (field) => {
      const t = createTestBackend();
      process.env.TELEMETRY_INGEST_SECRET = CLAIM_SECRET;
      await enableUnifiedJurisdictions(t);
      const owner = await createUser(t, `claim-unicode-${crypto.randomUUID()}@example.com`);
      const jurisdictionId = await createGeographicJurisdiction(t);
      const client = t.withIdentity({ subject: owner.userId, sessionId: owner.sessionId });
      await client.mutation(api.chats.ensure, { externalId: "unicode-chat", jurisdictionId });
      const originalContent = field === "assistant content" ? "\uD800" : "Bound answer";
      const forgedContent = field === "assistant content" ? "\uFFFD" : originalContent;
      const originalCitations: Citation[] = [{
        label: field === "citation label" ? "\uD800" : "Selected",
        jurisdictionId,
        jurisdictionName: "Ghana",
        jurisdictionKind: "geographic",
        relation: "selected",
      }];
      const forgedCitations = field === "citation label"
        ? [{ ...originalCitations[0], label: "\uFFFD" }]
        : originalCitations;
      const claim = await issueClaim(t, client, {
        externalId: "unicode-chat",
        jurisdictionId,
        clientId: "unicode-assistant",
        content: originalContent,
        citations: originalCitations,
      });

      await expect(client.mutation(api.chats.appendMessages, {
        externalId: "unicode-chat",
        jurisdictionId,
        lastMessage: "Rejected collision",
        messages: [{
          role: "assistant",
          content: forgedContent,
          clientId: "unicode-assistant",
          citations: forgedCitations,
          citationClaim: claim.citationClaim,
        }],
      })).rejects.toThrow("INVALID_CHAT_CITATION_CLAIM");
      expect(await t.run((ctx) => ctx.db.query("messages").take(2))).toEqual([]);
      const claims = await t.run((ctx) => ctx.db.query("chatCitationClaims").take(2));
      expect(claims).toHaveLength(1);
      expect(Object.keys(claims[0]).sort()).toEqual([
        "_creationTime",
        "_id",
        "assistantClientIdBinding",
        "assistantContentBinding",
        "chatSessionId",
        "expiresAt",
        "jurisdictionId",
        "orderedCitationBinding",
        "ownerBinding",
        "sessionBinding",
        "tokenHash",
      ]);
    },
  );

  it("rejects a non-ASCII claim binding before constructing HMAC proof parts", async () => {
    await expect(citationClaimIssueProofParts({
      externalId: "claim-chat",
      jurisdictionId: "jurisdiction-id",
      assistantClientIdBinding: `\uD800${"a".repeat(42)}`,
      assistantContentBinding: "b".repeat(43),
      orderedCitationBinding: "c".repeat(43),
    })).rejects.toThrow("INVALID_CHAT_CITATION_BINDING");
  });

  it.each<[string, { content?: string; clientId?: string; citations?: "label" | "order" }]>([
    ["content", { content: "Forged answer" }],
    ["client id", { clientId: "forged-client" }],
    ["label", { citations: "label" }],
    ["order", { citations: "order" }],
  ])("rejects a citation claim with forged %s without inserting", async (_case, forged) => {
    const t = createTestBackend();
    process.env.TELEMETRY_INGEST_SECRET = CLAIM_SECRET;
    await enableUnifiedJurisdictions(t);
    const owner = await createUser(t, `claim-forgery-${crypto.randomUUID()}@example.com`);
    const selectedId = await createGeographicJurisdiction(t);
    const ancestorId = await t.run(async (ctx) => {
      const now = Date.now();
      const id = await ctx.db.insert("jurisdictions", {
        name: "West Africa", slug: `west-africa-${crypto.randomUUID()}`, status: "enabled", isDefault: false,
        providerSyncState: "synced", kind: "geographic", visibility: "public",
        createdBy: "fixture", updatedBy: "fixture", createdAt: now, updatedAt: now,
      });
      await ctx.db.insert("geographicJurisdictions", {
        jurisdictionId: id, googlePlaceId: `place-${crypto.randomUUID()}`, level: "region",
        countryCode: "GH", latitude: 1, longitude: 1, formattedAddress: "West Africa", createdAt: now, updatedAt: now,
      });
      const selectedProfile = await ctx.db.query("geographicJurisdictions")
        .withIndex("by_jurisdictionId", (q) => q.eq("jurisdictionId", selectedId)).unique();
      await ctx.db.patch(selectedProfile!._id, { level: "town", parentJurisdictionId: id, updatedAt: now });
      return id;
    });
    const client = t.withIdentity({ subject: owner.userId, sessionId: owner.sessionId });
    await client.mutation(api.chats.ensure, { externalId: "forgery-chat", jurisdictionId: selectedId });
    const citations: Citation[] = [
      { label: "Selected", jurisdictionId: selectedId, jurisdictionName: "Ghana", jurisdictionKind: "geographic", relation: "selected" },
      { label: "Ancestor", jurisdictionId: ancestorId, jurisdictionName: "West Africa", jurisdictionKind: "geographic", relation: "geographic_ancestor" },
    ];
    const claim = await issueClaim(t, client, {
      externalId: "forgery-chat", jurisdictionId: selectedId, clientId: "assistant-original", content: "Original", citations,
    });
    const forgedCitations = forged.citations === "label"
      ? [{ ...citations[0], label: "Forged label" }, citations[1]]
      : forged.citations === "order" ? [...citations].reverse() : citations;
    await expect(client.mutation(api.chats.appendMessages, {
      externalId: "forgery-chat", jurisdictionId: selectedId, lastMessage: "Rejected",
      messages: [{
        role: "assistant",
        content: forged.content ?? "Original",
        clientId: forged.clientId ?? "assistant-original",
        citations: forgedCitations,
        citationClaim: claim.citationClaim,
      }],
    })).rejects.toThrow("INVALID_CHAT_CITATION_CLAIM");
    expect(await t.run((ctx) => ctx.db.query("messages").take(2))).toEqual([]);
  });

  it("rejects claim use by a different owner or auth session and against a different chat selection", async () => {
    const t = createTestBackend();
    process.env.TELEMETRY_INGEST_SECRET = CLAIM_SECRET;
    await enableUnifiedJurisdictions(t);
    const owner = await createUser(t, `claim-owner-${crypto.randomUUID()}@example.com`);
    const other = await createUser(t, `claim-other-${crypto.randomUUID()}@example.com`);
    const jurisdictionId = await createGeographicJurisdiction(t);
    const otherJurisdictionId = await createGeographicJurisdiction(t);
    const ownerClient = t.withIdentity({ subject: owner.userId, sessionId: owner.sessionId });
    const otherClient = t.withIdentity({ subject: other.userId, sessionId: other.sessionId });
    await ownerClient.mutation(api.chats.ensure, { externalId: "bound-chat", jurisdictionId });
    await ownerClient.mutation(api.chats.ensure, { externalId: "other-chat", jurisdictionId });
    await ownerClient.mutation(api.chats.ensure, { externalId: "other-selection", jurisdictionId: otherJurisdictionId });
    await otherClient.mutation(api.chats.ensure, { externalId: "bound-chat", jurisdictionId });
    const citations: Citation[] = [{ label: "Selected", jurisdictionId, jurisdictionName: "Ghana", jurisdictionKind: "geographic", relation: "selected" }];
    const claim = await issueClaim(t, ownerClient, {
      externalId: "bound-chat", jurisdictionId, clientId: "bound-assistant", content: "Bound", citations,
    });
    const append = (client: typeof ownerClient, externalId = "bound-chat") => client.mutation(api.chats.appendMessages, {
      externalId, jurisdictionId, lastMessage: "Bound",
      messages: [{ role: "assistant", content: "Bound", clientId: "bound-assistant", citations, citationClaim: claim.citationClaim }],
    });
    await expect(append(otherClient)).rejects.toThrow("INVALID_CHAT_CITATION_CLAIM");
    const secondSessionId = await t.run(async (ctx) => (await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "session", data: { token: crypto.randomUUID(), userId: owner.userId, expiresAt: Date.now() + 60_000, createdAt: Date.now(), updatedAt: Date.now() } },
    }))._id);
    await expect(append(t.withIdentity({ subject: owner.userId, sessionId: secondSessionId })))
      .rejects.toThrow("INVALID_CHAT_CITATION_CLAIM");
    await expect(append(ownerClient, "other-chat")).rejects.toThrow("INVALID_CHAT_CITATION_CLAIM");
    await expect(ownerClient.mutation(api.chats.appendMessages, {
      externalId: "other-selection", jurisdictionId: otherJurisdictionId, lastMessage: "Bound",
      messages: [{ role: "assistant", content: "Bound", clientId: "bound-assistant", citations, citationClaim: claim.citationClaim }],
    })).rejects.toThrow("INVALID_CHAT_CITATIONS");
    expect(await t.run((ctx) => ctx.db.query("messages").take(5))).toEqual([]);
  });

  it("rejects an expired claim and a service-issued unrelated ancestor", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-10T12:00:00.000Z"));
      const t = createTestBackend();
      process.env.TELEMETRY_INGEST_SECRET = CLAIM_SECRET;
      await enableUnifiedJurisdictions(t);
      const owner = await createUser(t, `claim-expiry-${crypto.randomUUID()}@example.com`);
      const selectedId = await createGeographicJurisdiction(t);
      const unrelatedId = await t.run(async (ctx) => {
        const now = Date.now();
        const id = await ctx.db.insert("jurisdictions", {
          name: "Unrelated", slug: `unrelated-${crypto.randomUUID()}`, status: "enabled", isDefault: false,
          providerSyncState: "synced", kind: "geographic", visibility: "public",
          createdBy: "fixture", updatedBy: "fixture", createdAt: now, updatedAt: now,
        });
        await ctx.db.insert("geographicJurisdictions", {
          jurisdictionId: id, googlePlaceId: `place-${crypto.randomUUID()}`, level: "country",
          countryCode: "NG", latitude: 2, longitude: 2, formattedAddress: "Unrelated", createdAt: now, updatedAt: now,
        });
        return id;
      });
      const client = t.withIdentity({ subject: owner.userId, sessionId: owner.sessionId });
      await client.mutation(api.chats.ensure, { externalId: "expiry-chat", jurisdictionId: selectedId });
      const selectedCitation: Citation[] = [{ label: "Selected", jurisdictionId: selectedId, jurisdictionName: "Ghana", jurisdictionKind: "geographic", relation: "selected" }];
      const claim = await issueClaim(t, client, {
        externalId: "expiry-chat", jurisdictionId: selectedId, clientId: "expiring", content: "Expires", citations: selectedCitation,
      });
      vi.advanceTimersByTime(120_001);
      await expect(client.mutation(api.chats.appendMessages, {
        externalId: "expiry-chat", jurisdictionId: selectedId, lastMessage: "Expires",
        messages: [{ role: "assistant", content: "Expires", clientId: "expiring", citations: selectedCitation, citationClaim: claim.citationClaim }],
      })).rejects.toThrow("INVALID_CHAT_CITATION_CLAIM");

      const unrelated: Citation[] = [{ label: "Forged", jurisdictionId: unrelatedId, jurisdictionName: "Unrelated", jurisdictionKind: "geographic", relation: "geographic_ancestor" }];
      await expect(issueClaim(t, client, {
        externalId: "expiry-chat", jurisdictionId: selectedId, clientId: "unrelated", content: "Forged", citations: unrelated,
      })).rejects.toThrow("INVALID_CHAT_CITATIONS");
      expect(await t.run((ctx) => ctx.db.query("messages").take(2))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts only geographic citations inside a linked organization scope", async () => {
    const t = createTestBackend();
    process.env.TELEMETRY_INGEST_SECRET = CLAIM_SECRET;
    await enableUnifiedJurisdictions(t);
    const owner = await createUser(t, `claim-org-${crypto.randomUUID()}@example.com`);
    const linkedId = await createGeographicJurisdiction(t);
    const unrelatedId = await createGeographicJurisdiction(t);
    const organizationId = await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.patch(unrelatedId, { name: "Nigeria", legacyCountryCode: "NG", updatedAt: now });
      const unrelatedProfile = await ctx.db.query("geographicJurisdictions")
        .withIndex("by_jurisdictionId", (q) => q.eq("jurisdictionId", unrelatedId)).unique();
      await ctx.db.patch(unrelatedProfile!._id, { countryCode: "NG", updatedAt: now });
      const organizationId = await ctx.db.insert("organizations", {
        name: "Linked University", slug: `linked-university-${crypto.randomUUID()}`, class: "university", status: "active",
        createdBy: "fixture", updatedBy: "fixture", createdAt: now, updatedAt: now,
      });
      const jurisdictionId = await ctx.db.insert("jurisdictions", {
        name: "Linked University Policy", slug: `linked-policy-${crypto.randomUUID()}`, status: "enabled", isDefault: false,
        providerSyncState: "synced", kind: "organizational", visibility: "public", organizationId,
        createdBy: "fixture", updatedBy: "fixture", createdAt: now, updatedAt: now,
      });
      const profileId = await ctx.db.insert("organizationalJurisdictions", {
        jurisdictionId, scopeMode: "linked_geographies", createdAt: now, updatedAt: now,
      });
      const linkedProfile = await ctx.db.query("geographicJurisdictions")
        .withIndex("by_jurisdictionId", (q) => q.eq("jurisdictionId", linkedId)).unique();
      await ctx.db.insert("organizationGeographicScopes", {
        organizationalJurisdictionId: profileId, geographicJurisdictionId: linkedProfile!._id, createdAt: now,
      });
      return jurisdictionId;
    });
    const client = t.withIdentity({ subject: owner.userId, sessionId: owner.sessionId });
    await client.mutation(api.chats.ensure, { externalId: "linked-org-chat", jurisdictionId: organizationId });
    const allowed: Citation[] = [
      {
        label: "University policy",
        jurisdictionId: organizationId,
        jurisdictionName: "Linked University Policy",
        jurisdictionKind: "organizational",
        relation: "selected",
      },
      {
        label: "Ghana scope", jurisdictionId: linkedId, jurisdictionName: "Ghana",
        jurisdictionKind: "geographic", relation: "organizational_geography",
      },
    ];
    const claim = await issueClaim(t, client, {
      externalId: "linked-org-chat", jurisdictionId: organizationId,
      clientId: "linked-answer", content: "Linked answer", citations: allowed,
    });
    await expect(client.mutation(api.chats.appendMessages, {
      externalId: "linked-org-chat", jurisdictionId: organizationId, lastMessage: "Linked answer",
      messages: [{ role: "assistant", content: "Linked answer", clientId: "linked-answer", citations: allowed, citationClaim: claim.citationClaim }],
    })).resolves.toEqual({ id: "linked-org-chat" });

    const unrelated: Citation[] = [{
      label: "Nigeria scope", jurisdictionId: unrelatedId, jurisdictionName: "Nigeria",
      jurisdictionKind: "geographic", relation: "organizational_geography",
    }];
    await expect(issueClaim(t, client, {
      externalId: "linked-org-chat", jurisdictionId: organizationId,
      clientId: "unrelated-answer", content: "Unrelated answer", citations: unrelated,
    })).rejects.toThrow("INVALID_CHAT_CITATIONS");
    const stored = await client.query(api.chats.listMessages, {
      externalId: "linked-org-chat", paginationOpts: { numItems: 20, cursor: null },
    });
    expect(stored.page.map((message) => message.content)).toEqual(["Linked answer"]);
  });

  it("checks stored-ID access while rollout is off but keeps its country snapshot immutable", async () => {
    const t = createTestBackend();
    await enableUnifiedJurisdictions(t);
    const owner = await createUser(t, `snapshot-owner-${crypto.randomUUID()}@example.com`);
    const jurisdictionId = await createGeographicJurisdiction(t);
    const client = t.withIdentity({ subject: owner.userId, sessionId: owner.sessionId });
    await client.mutation(api.chats.ensure, { externalId: "snapshot-chat", jurisdictionId, country: "GH" });
    await t.run(async (ctx) => {
      await ctx.db.patch(jurisdictionId, { legacyCountryCode: "NG", updatedAt: Date.now() });
      const flag = await ctx.db.query("featureFlags")
        .withIndex("by_key_and_environment", (q) => q.eq("key", "unified_jurisdictions").eq("environment", "test")).unique();
      await ctx.db.patch(flag!._id, { enabled: false, updatedAt: Date.now() });
    });
    await expect(client.query(api.chats.getByExternalId, { externalId: "snapshot-chat" }))
      .resolves.toMatchObject({ jurisdictionId, country: "GH" });
    await t.run((ctx) => ctx.db.patch(jurisdictionId, { status: "archived", updatedAt: Date.now() }));
    await expect(client.query(api.chats.getByExternalId, { externalId: "snapshot-chat" })).resolves.toBeNull();
    await expect(client.query(api.chats.listMessages, {
      externalId: "snapshot-chat", paginationOpts: { numItems: 20, cursor: null },
    })).resolves.toMatchObject({ page: [] });
    await expect(client.mutation(api.chats.appendMessages, {
      externalId: "snapshot-chat", jurisdictionId, lastMessage: "Denied", messages: [{ role: "assistant", content: "Denied" }],
    })).rejects.toThrow("That jurisdiction is not available");
    await expect(client.mutation(api.chats.remove, { externalId: "snapshot-chat" }))
      .rejects.toThrow("That jurisdiction is not available");
  });

  it("completes against an accessible stored-ID selection while rollout is off", async () => {
    const t = createTestBackend();
    process.env.TELEMETRY_INGEST_SECRET = CLAIM_SECRET;
    await enableUnifiedJurisdictions(t);
    const owner = await createUser(t, `rollback-claim-${crypto.randomUUID()}@example.com`);
    const jurisdictionId = await createGeographicJurisdiction(t);
    const client = t.withIdentity({ subject: owner.userId, sessionId: owner.sessionId });
    await client.mutation(api.chats.ensure, { externalId: "rollback-claim", jurisdictionId });
    await t.run(async (ctx) => {
      const flag = await ctx.db.query("featureFlags")
        .withIndex("by_key_and_environment", (q) =>
          q.eq("key", "unified_jurisdictions").eq("environment", "test"))
        .unique();
      await ctx.db.patch(flag!._id, { enabled: false, updatedAt: Date.now() });
    });
    const citations: Citation[] = [{
      label: "Selected",
      jurisdictionId,
      jurisdictionName: "Ghana",
      jurisdictionKind: "geographic",
      relation: "selected",
    }];

    await expect(issueClaim(t, client, {
      externalId: "rollback-claim",
      jurisdictionId,
      clientId: "blocked-claim",
      content: "Blocked",
      citations,
    })).resolves.toMatchObject({ status: "completed", outcome: "success" });
    expect(await t.run((ctx) => ctx.db.query("chatCitationClaims").take(2))).toHaveLength(1);
  });

  it.each(["user", "assistant"] as const)(
    "rejects an unsaved %s message for an accessible stored-ID chat while rollout is off",
    async (role) => {
      const t = createTestBackend();
      process.env.TELEMETRY_INGEST_SECRET = CLAIM_SECRET;
      await enableUnifiedJurisdictions(t);
      const owner = await createUser(t, `rollback-${role}-${crypto.randomUUID()}@example.com`);
      const jurisdictionId = await createGeographicJurisdiction(t);
      const client = t.withIdentity({ subject: owner.userId, sessionId: owner.sessionId });
      await client.mutation(api.chats.ensure, { externalId: `rollback-${role}`, jurisdictionId });
      await client.mutation(api.chats.appendMessages, {
        externalId: `rollback-${role}`,
        jurisdictionId,
        lastMessage: "Baseline",
        messages: [{ role: "user", content: "Baseline", clientId: "baseline", createdAt: 10 }],
      });
      const citations: Citation[] = [{
        label: "Selected",
        jurisdictionId,
        jurisdictionName: "Ghana",
        jurisdictionKind: "geographic",
        relation: "selected",
      }];
      const pendingClaim = role === "assistant"
        ? await issueClaim(t, client, {
            externalId: `rollback-${role}`,
            jurisdictionId,
            clientId: "unsaved",
            content: "Unsaved",
            citations,
          })
        : null;
      await t.run(async (ctx) => {
        const flag = await ctx.db.query("featureFlags")
          .withIndex("by_key_and_environment", (q) =>
            q.eq("key", "unified_jurisdictions").eq("environment", "test"))
          .unique();
        await ctx.db.patch(flag!._id, { enabled: false, updatedAt: Date.now() });
      });
      const message = role === "assistant"
        ? {
            role,
            content: "Unsaved",
            clientId: "unsaved",
            citations,
            citationClaim: pendingClaim!.citationClaim,
          }
        : { role, content: "Unsaved", clientId: "unsaved" };

      await expect(client.mutation(api.chats.appendMessages, {
        externalId: `rollback-${role}`,
        jurisdictionId,
        title: "Must not patch",
        lastMessage: "Must not patch",
        messages: [message],
      })).rejects.toThrow("That jurisdiction is not available");
      const stored = await client.query(api.chats.listMessages, {
        externalId: `rollback-${role}`,
        paginationOpts: { numItems: 20, cursor: null },
      });
      expect(stored.page.map((row) => row.content)).toEqual(["Baseline"]);
      await expect(client.query(api.chats.getByExternalId, { externalId: `rollback-${role}` }))
        .resolves.toMatchObject({ title: "New chat", lastMessage: "Baseline", messageCount: 1 });
      expect(await t.run((ctx) => ctx.db.query("chatCitationClaims").take(2)))
        .toHaveLength(role === "assistant" ? 1 : 0);
    },
  );

  it("allows exact zero-write retries for a stored-ID chat while rollout is off", async () => {
    const t = createTestBackend();
    await enableUnifiedJurisdictions(t);
    const owner = await createUser(t, `rollback-retry-${crypto.randomUUID()}@example.com`);
    const jurisdictionId = await createGeographicJurisdiction(t);
    const client = t.withIdentity({ subject: owner.userId, sessionId: owner.sessionId });
    await client.mutation(api.chats.ensure, { externalId: "rollback-retry", jurisdictionId });
    await client.mutation(api.chats.appendMessages, {
      externalId: "rollback-retry",
      jurisdictionId,
      lastMessage: "Saved",
      messages: [{ role: "user", content: "Saved", clientId: "saved", createdAt: 100 }],
    });
    await t.run(async (ctx) => {
      const flag = await ctx.db.query("featureFlags")
        .withIndex("by_key_and_environment", (q) =>
          q.eq("key", "unified_jurisdictions").eq("environment", "test"))
        .unique();
      await ctx.db.patch(flag!._id, { enabled: false, updatedAt: Date.now() });
    });
    const sessionBeforeRetry = await t.run((ctx) => ctx.db.query("chatSessions")
      .withIndex("by_user_externalId", (q) =>
        q.eq("userId", owner.userId).eq("externalId", "rollback-retry"))
      .unique());

    for (const createdAt of [undefined, 100]) {
      await expect(client.mutation(api.chats.appendMessages, {
        externalId: "rollback-retry",
        jurisdictionId,
        title: "Must not patch",
        lastMessage: "Must not patch",
        messages: [{
          role: "user",
          content: "Saved",
          clientId: "saved",
          ...(createdAt === undefined ? {} : { createdAt }),
        }],
      })).resolves.toEqual({ id: "rollback-retry" });
    }
    const messages = await client.query(api.chats.listMessages, {
      externalId: "rollback-retry",
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(messages.page).toHaveLength(1);
    const sessionAfterRetry = await t.run((ctx) => ctx.db.query("chatSessions")
      .withIndex("by_user_externalId", (q) =>
        q.eq("userId", owner.userId).eq("externalId", "rollback-retry"))
      .unique());
    expect(sessionAfterRetry).toEqual(sessionBeforeRetry);
    await expect(client.query(api.chats.getByExternalId, { externalId: "rollback-retry" }))
      .resolves.toMatchObject({ title: "New chat", lastMessage: "Saved", messageCount: 1 });
  });

  it("removes every member-only chat boundary immediately when membership becomes inactive", async () => {
    const t = createTestBackend();
    await enableUnifiedJurisdictions(t);
    const owner = await createUser(t, `chat-member-${crypto.randomUUID()}@example.com`);
    const { jurisdictionId, membershipId } = await t.run(async (ctx) => {
      const now = Date.now();
      const organizationId = await ctx.db.insert("organizations", {
        name: "Private University", slug: "private-university", class: "university", status: "active",
        createdBy: "fixture", updatedBy: "fixture", createdAt: now, updatedAt: now,
      });
      const membershipId = await ctx.db.insert("organizationMemberships", {
        organizationId, userId: owner.userId, status: "active", createdAt: now, updatedAt: now,
      });
      const jurisdictionId = await ctx.db.insert("jurisdictions", {
        name: "Private University Rules", slug: "private-university-rules", status: "enabled",
        isDefault: false, providerSyncState: "synced", kind: "organizational", visibility: "members",
        organizationId, createdBy: "fixture", updatedBy: "fixture", createdAt: now, updatedAt: now,
      });
      await ctx.db.insert("organizationalJurisdictions", {
        jurisdictionId, scopeMode: "global", createdAt: now, updatedAt: now,
      });
      return { jurisdictionId, membershipId };
    });
    const client = t.withIdentity({ subject: owner.userId, sessionId: owner.sessionId });
    await client.mutation(api.chats.ensure, { externalId: "private-chat", jurisdictionId });
    await client.mutation(api.chats.appendMessages, {
      externalId: "private-chat", jurisdictionId, lastMessage: "Saved",
      messages: [{ role: "assistant", content: "Saved" }],
    });
    await t.run((ctx) => ctx.db.patch(membershipId, { status: "inactive", updatedAt: Date.now() }));

    await expect(client.query(api.chats.list, { paginationOpts: { numItems: 20, cursor: null } }))
      .resolves.toMatchObject({ page: [] });
    await expect(client.query(api.chats.getByExternalId, { externalId: "private-chat" })).resolves.toBeNull();
    await expect(client.query(api.chats.listMessages, {
      externalId: "private-chat", paginationOpts: { numItems: 20, cursor: null },
    })).resolves.toMatchObject({ page: [] });
    await expect(client.mutation(api.chats.appendMessages, {
      externalId: "private-chat", jurisdictionId, lastMessage: "Denied",
      messages: [{ role: "assistant", content: "Denied" }],
    })).rejects.toThrow("That jurisdiction is not available");
    await expect(client.mutation(api.chats.remove, { externalId: "private-chat" }))
      .rejects.toThrow("That jurisdiction is not available");
    const stored = await t.run(async (ctx) => {
      const session = await ctx.db.query("chatSessions")
        .withIndex("by_user_externalId", (q) => q.eq("userId", owner.userId).eq("externalId", "private-chat"))
        .unique();
      return session
        ? await ctx.db.query("messages").withIndex("by_session", (q) => q.eq("sessionId", session._id)).take(3)
        : [];
    });
    expect(stored.map((message) => message.content)).toEqual(["Saved"]);
  });

  it.each(["citations", "citationClaim"] as const)(
    "rejects legacy local migration messages containing %s with zero writes",
    async (field) => {
      const t = createTestBackend();
      const owner = await createUser(t, `migration-${crypto.randomUUID()}@example.com`);
      const jurisdictionId = await createGeographicJurisdiction(t);
      const message = field === "citations"
        ? {
            role: "assistant" as const,
            content: "Untrusted local citation",
            citations: [{
              label: "Forged",
              jurisdictionId,
              jurisdictionName: "Ghana",
              jurisdictionKind: "geographic" as const,
              relation: "selected" as const,
            }],
          }
        : {
            role: "assistant" as const,
            content: "Untrusted local claim",
            citationClaim: "untrusted-local-claim",
          };

      await expect(t.withIdentity({ subject: owner.userId, sessionId: owner.sessionId })
        .mutation(api.chats.migrateFromLocal, {
          sessions: [{
            externalId: `migration-${field}`,
            title: "Local migration",
            lastMessage: message.content,
            messageCount: 1,
            updatedAt: 1,
            messages: [message],
          }],
        } as never)).rejects.toThrow();
      expect(await t.run((ctx) => ctx.db.query("chatSessions").take(2))).toEqual([]);
      expect(await t.run((ctx) => ctx.db.query("messages").take(2))).toEqual([]);
    },
  );

  it("normalizes every caller page size to a finite positive integer within the cap", () => {
    expect(normalizePageSize(Number.NaN, 30)).toBe(1);
    expect(normalizePageSize(Number.POSITIVE_INFINITY, 30)).toBe(1);
    expect(normalizePageSize(-2, 30)).toBe(1);
    expect(normalizePageSize(0, 30)).toBe(1);
    expect(normalizePageSize(7.9, 30)).toBe(7);
    expect(normalizePageSize(10_000, 30)).toBe(30);
  });

  it("uses cursor pages, clamps session page size, and keeps newest sessions first", async () => {
    const t = createTestBackend();
    const user = await createUser(t, `chat-owner-${crypto.randomUUID()}@example.com`);

    await t.run(async (ctx) => {
      for (let index = 0; index < 31; index += 1) {
        await ctx.db.insert("chatSessions", {
          userId: user.userId,
          externalId: `chat-${index}`,
          title: `Chat ${index}`,
          lastMessage: "",
          messageCount: 0,
          updatedAt: index,
        });
      }
    });

    const first = await t
      .withIdentity({ subject: user.userId, sessionId: user.sessionId })
      .query(api.chats.list, { paginationOpts: { numItems: 1_000, cursor: null } });

    expect(first.page).toHaveLength(30);
    expect(first.isDone).toBe(false);
    expect(first.page.map((session) => session.id)).toEqual(
      Array.from({ length: 30 }, (_, index) => `chat-${30 - index}`),
    );

    const second = await t
      .withIdentity({ subject: user.userId, sessionId: user.sessionId })
      .query(api.chats.list, {
        paginationOpts: { numItems: 30, cursor: first.continueCursor },
      });
    expect(second.page.map((session) => session.id)).toEqual(["chat-0"]);
    expect(second.isDone).toBe(true);
  }, 30_000);

  it("returns chronological message pages, clamps message page size, and enforces ownership", async () => {
    const t = createTestBackend();
    const owner = await createUser(t, `chat-owner-${crypto.randomUUID()}@example.com`);
    const otherUser = await createUser(t, `chat-other-${crypto.randomUUID()}@example.com`);

    await t.run(async (ctx) => {
      const chatId = await ctx.db.insert("chatSessions", {
        userId: owner.userId,
        externalId: "chat-1",
        title: "Chat 1",
        lastMessage: "",
        messageCount: 51,
        updatedAt: 51,
      });
      for (let index = 0; index < 51; index += 1) {
        await ctx.db.insert("messages", {
          sessionId: chatId,
          role: index % 2 === 0 ? "user" : "assistant",
          content: `Message ${index}`,
          clientId: `message-${index}`,
          createdAt: index,
        });
      }
    });

    const first = await t
      .withIdentity({ subject: owner.userId, sessionId: owner.sessionId })
      .query(api.chats.listMessages, {
        externalId: "chat-1",
        paginationOpts: { numItems: 1_000, cursor: null },
      });

    expect(first.page).toHaveLength(50);
    expect(first.isDone).toBe(false);
    expect(first.page.map((message) => message.content)).toEqual(
      Array.from({ length: 50 }, (_, index) => `Message ${index + 1}`),
    );
    expect(first.page[0]).toMatchObject({
      storageId: expect.any(String),
      clientId: "message-1",
      creationTime: expect.any(Number),
    });

    const second = await t
      .withIdentity({ subject: owner.userId, sessionId: owner.sessionId })
      .query(api.chats.listMessages, {
        externalId: "chat-1",
        paginationOpts: { numItems: 50, cursor: first.continueCursor },
      });
    expect(second.page.map((message) => message.content)).toEqual(["Message 0"]);
    expect(second.isDone).toBe(true);

    await expect(
      t
        .withIdentity({ subject: otherUser.userId, sessionId: otherUser.sessionId })
        .query(api.chats.listMessages, {
          externalId: "chat-1",
          paginationOpts: { numItems: 50, cursor: null },
        }),
    ).resolves.toMatchObject({ page: [], isDone: true });
  }, 30_000);

  it("keeps duplicate client IDs as distinct storage rows with a server-controlled equal-time order", async () => {
    const t = createTestBackend();
    const owner = await createUser(t, `chat-owner-${crypto.randomUUID()}@example.com`);

    await t.run(async (ctx) => {
      const chatId = await ctx.db.insert("chatSessions", {
        userId: owner.userId,
        externalId: "duplicate-client-id",
        title: "Duplicate client IDs",
        lastMessage: "",
        messageCount: 2,
        updatedAt: 1,
      });
      await ctx.db.insert("messages", {
        sessionId: chatId,
        role: "user",
        content: "First stored row",
        clientId: "duplicate",
        createdAt: 100,
      });
      await ctx.db.insert("messages", {
        sessionId: chatId,
        role: "user",
        content: "Second stored row",
        clientId: "duplicate",
        createdAt: 100,
      });
    });

    const page = await t
      .withIdentity({ subject: owner.userId, sessionId: owner.sessionId })
      .query(api.chats.listMessages, {
        externalId: "duplicate-client-id",
        paginationOpts: { numItems: 50, cursor: null },
      });

    expect(page.page).toHaveLength(2);
    expect(page.page.map((message) => message.storageId)).toHaveLength(2);
    expect(new Set(page.page.map((message) => message.storageId)).size).toBe(2);
    expect(page.page.map((message) => message.clientId)).toEqual(["duplicate", "duplicate"]);
    expect(page.page.map((message) => message.creationTime)).toEqual(
      [...page.page.map((message) => message.creationTime)].sort((a, b) => a - b),
    );
  });

  it("requires a supplied retry timestamp to exactly match the stored client-ID row", async () => {
    const t = createTestBackend();
    await createGeographicJurisdiction(t);
    const owner = await createUser(t, `created-at-retry-${crypto.randomUUID()}@example.com`);
    const client = t.withIdentity({ subject: owner.userId, sessionId: owner.sessionId });
    await client.mutation(api.chats.ensure, { externalId: "created-at-retry", country: "GH" });
    await client.mutation(api.chats.appendMessages, {
      externalId: "created-at-retry",
      lastMessage: "Original",
      messages: [{ role: "user", content: "Original", clientId: "same-client", createdAt: 100 }],
    });

    await expect(client.mutation(api.chats.appendMessages, {
      externalId: "created-at-retry",
      title: "Must not patch",
      lastMessage: "Must not patch",
      messages: [{ role: "user", content: "Original", clientId: "same-client", createdAt: 101 }],
    })).rejects.toThrow("CHAT_CLIENT_ID_CONFLICT");
    for (const createdAt of [undefined, 100]) {
      await expect(client.mutation(api.chats.appendMessages, {
        externalId: "created-at-retry",
        title: "Must not patch",
        lastMessage: "Must not patch",
        messages: [{
          role: "user",
          content: "Original",
          clientId: "same-client",
          ...(createdAt === undefined ? {} : { createdAt }),
        }],
      })).resolves.toEqual({ id: "created-at-retry" });
    }
    const messages = await client.query(api.chats.listMessages, {
      externalId: "created-at-retry",
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(messages.page).toHaveLength(1);
    expect(messages.page[0].createdAt).toBe(100);
    await expect(client.query(api.chats.getByExternalId, { externalId: "created-at-retry" }))
      .resolves.toMatchObject({ title: "New chat", lastMessage: "Original", messageCount: 1 });
  });

  it.each(["identical", "conflicting"] as const)(
    "%s new client IDs in one append batch preserve the idempotency invariant",
    async (variant) => {
      const t = createTestBackend();
      await createGeographicJurisdiction(t);
      const owner = await createUser(t, `same-batch-${variant}-${crypto.randomUUID()}@example.com`);
      const client = t.withIdentity({ subject: owner.userId, sessionId: owner.sessionId });
      await client.mutation(api.chats.ensure, { externalId: `same-batch-${variant}`, country: "GH" });
      const first = { role: "user" as const, content: "First", clientId: "same-client", createdAt: 100 };
      const second = variant === "identical" ? { ...first } : { ...first, content: "Conflicting" };
      const append = client.mutation(api.chats.appendMessages, {
        externalId: `same-batch-${variant}`,
        lastMessage: second.content,
        messages: [first, second],
      });

      if (variant === "conflicting") await expect(append).rejects.toThrow("CHAT_CLIENT_ID_CONFLICT");
      else await expect(append).resolves.toEqual({ id: "same-batch-identical" });
      const messages = await client.query(api.chats.listMessages, {
        externalId: `same-batch-${variant}`,
        paginationOpts: { numItems: 20, cursor: null },
      });
      expect(messages.page.map((row) => row.content)).toEqual(
        variant === "identical" ? ["First"] : [],
      );
      await expect(client.query(api.chats.getByExternalId, { externalId: `same-batch-${variant}` }))
        .resolves.toMatchObject({
          messageCount: variant === "identical" ? 1 : 0,
          lastMessage: variant === "identical" ? "First" : "",
        });
    },
  );

  it("deletes messages through a bounded internal continuation after hiding the owned session", async () => {
    vi.useFakeTimers();
    try {
      const t = createTestBackend();
      const owner = await createUser(t, `chat-owner-${crypto.randomUUID()}@example.com`);
      const sessionId = await t.run(async (ctx) => {
        const id = await ctx.db.insert("chatSessions", {
          userId: owner.userId,
          externalId: "delete-batches",
          title: "Delete batches",
          lastMessage: "",
          messageCount: 101,
          updatedAt: 1,
        });
        for (let index = 0; index < 101; index += 1) {
          await ctx.db.insert("messages", {
            sessionId: id,
            role: "user",
            content: `Delete ${index}`,
            createdAt: index,
          });
        }
        return id;
      });

      const firstBatch = await t.mutation(internal.chats.deleteMessageBatch, { sessionId });
      expect(firstBatch).toEqual({ deletedCount: 100, hasMore: true });

      await t.finishAllScheduledFunctions(() => vi.runAllTimers());
      const remaining = await t.run((ctx) =>
        ctx.db.query("messages").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).take(102),
      );
      expect(remaining).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it("lets only the owner hide a session and schedules its cleanup", async () => {
    vi.useFakeTimers();
    try {
      const t = createTestBackend();
      const owner = await createUser(t, `chat-owner-${crypto.randomUUID()}@example.com`);
      const otherUser = await createUser(t, `chat-other-${crypto.randomUUID()}@example.com`);
      const sessionId = await t.run(async (ctx) => {
        const id = await ctx.db.insert("chatSessions", {
          userId: owner.userId,
          externalId: "owner-delete",
          title: "Owner delete",
          lastMessage: "",
          messageCount: 1,
          updatedAt: 1,
        });
        await ctx.db.insert("messages", {
          sessionId: id,
          role: "user",
          content: "Cleanup me",
          createdAt: 1,
        });
        return id;
      });

      await expect(
        t
          .withIdentity({ subject: otherUser.userId, sessionId: otherUser.sessionId })
          .mutation(api.chats.remove, { externalId: "owner-delete" }),
      ).resolves.toEqual({ deleted: false });
      await expect(
        t
          .withIdentity({ subject: owner.userId, sessionId: owner.sessionId })
          .mutation(api.chats.remove, { externalId: "owner-delete" }),
      ).resolves.toEqual({ deleted: true });
      await expect(
        t
          .withIdentity({ subject: owner.userId, sessionId: owner.sessionId })
          .query(api.chats.getByExternalId, { externalId: "owner-delete" }),
      ).resolves.toBeNull();

      await t.finishAllScheduledFunctions(() => vi.runAllTimers());
      const remaining = await t.run((ctx) =>
        ctx.db.query("messages").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).take(2),
      );
      expect(remaining).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it("does not recreate a session when an append arrives after its removal", async () => {
    vi.useFakeTimers();
    try {
      const t = createTestBackend();
      const owner = await createUser(t, `chat-owner-${crypto.randomUUID()}@example.com`);
      await t.run(async (ctx) => {
        await ctx.db.insert("chatSessions", {
          userId: owner.userId,
          externalId: "removed-before-append",
          title: "Removed before append",
          lastMessage: "",
          messageCount: 0,
          updatedAt: 1,
        });
      });

      await t
        .withIdentity({ subject: owner.userId, sessionId: owner.sessionId })
        .mutation(api.chats.remove, { externalId: "removed-before-append" });
      await expect(
        t
          .withIdentity({ subject: owner.userId, sessionId: owner.sessionId })
          .mutation(api.chats.appendMessages, {
            externalId: "removed-before-append",
            lastMessage: "Should not persist",
            messages: [{ role: "user", content: "Too late", clientId: "late-message", createdAt: 2 }],
          }),
      ).rejects.toThrow("Chat session not found");

      await t.finishAllScheduledFunctions(() => vi.runAllTimers());
      await expect(
        t
          .withIdentity({ subject: owner.userId, sessionId: owner.sessionId })
          .query(api.chats.getByExternalId, { externalId: "removed-before-append" }),
      ).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});
