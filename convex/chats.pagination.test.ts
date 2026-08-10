/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { normalizePageSize } from "./chats";
import authSchema from "./betterAuth/schema";
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

const issueCitationClaim = makeFunctionReference<"mutation">("chats:issueCitationClaim");

type Citation = {
  label: string;
  jurisdictionId: Id<"jurisdictions">;
  jurisdictionName: string;
  jurisdictionKind: "geographic" | "organizational";
  relation: "selected" | "geographic_ancestor" | "organizational_geography";
};

function base64url(bytes: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function testHmac(parts: readonly (string | number)[]) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(CLAIM_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64url(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(parts.map((part) => `${String(part).length}:${part}`).join("|")),
  ));
}

async function citationBindings(clientId: string, content: string, citations: Citation[]) {
  const clientIdBinding = await testHmac(["chat-citation-client-id-v1", clientId]);
  const contentBinding = await testHmac(["chat-citation-content-v1", content]);
  const citationParts: (string | number)[] = ["chat-citation-dto-v1", citations.length];
  for (const citation of citations) citationParts.push(
    citation.label,
    citation.jurisdictionId,
    citation.jurisdictionName,
    citation.jurisdictionKind,
    citation.relation,
  );
  return {
    clientIdBinding,
    contentBinding,
    orderedCitationBinding: await testHmac(citationParts),
  };
}

async function issueClaim(
  client: ReturnType<TestConvex<typeof schema>["withIdentity"]>,
  input: { externalId: string; jurisdictionId: Id<"jurisdictions">; clientId: string; content: string; citations: Citation[] },
) {
  const bindings = await citationBindings(input.clientId, input.content, input.citations);
  const serviceProof = await testHmac([
    "issue-chat-citation-claim-v1",
    input.externalId,
    input.jurisdictionId,
    bindings.clientIdBinding,
    bindings.contentBinding,
    bindings.orderedCitationBinding,
  ]);
  return await client.mutation(issueCitationClaim, {
    externalId: input.externalId,
    jurisdictionId: input.jurisdictionId,
    assistantClientId: input.clientId,
    assistantContent: input.content,
    citations: input.citations,
    assistantClientIdBinding: bindings.clientIdBinding,
    assistantContentBinding: bindings.contentBinding,
    orderedCitationBinding: bindings.orderedCitationBinding,
    serviceProof,
  });
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
    const claim = await issueClaim(client, {
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
    const claim = await issueClaim(client, {
      externalId: "claim-chat", jurisdictionId, clientId: "assistant-1", content: "Bound answer", citations,
    });

    const rawClaims = await t.run((ctx) => ctx.db.query("chatCitationClaims").take(2));
    expect(rawClaims).toHaveLength(1);
    expect(JSON.stringify(rawClaims)).not.toMatch(/Bound answer|Constitution|article 1|assistant-1/);
    expect(await t.run((ctx) => ctx.db.query("telemetryCorrelations").take(2))).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("queryRuns").take(2))).toEqual([]);

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
    const claim = await issueClaim(client, {
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
    const claim = await issueClaim(ownerClient, {
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
      const claim = await issueClaim(client, {
        externalId: "expiry-chat", jurisdictionId: selectedId, clientId: "expiring", content: "Expires", citations: selectedCitation,
      });
      vi.advanceTimersByTime(120_001);
      await expect(client.mutation(api.chats.appendMessages, {
        externalId: "expiry-chat", jurisdictionId: selectedId, lastMessage: "Expires",
        messages: [{ role: "assistant", content: "Expires", clientId: "expiring", citations: selectedCitation, citationClaim: claim.citationClaim }],
      })).rejects.toThrow("INVALID_CHAT_CITATION_CLAIM");

      const unrelated: Citation[] = [{ label: "Forged", jurisdictionId: unrelatedId, jurisdictionName: "Unrelated", jurisdictionKind: "geographic", relation: "geographic_ancestor" }];
      await expect(issueClaim(client, {
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
    const allowed: Citation[] = [{
      label: "Ghana scope", jurisdictionId: linkedId, jurisdictionName: "Ghana",
      jurisdictionKind: "geographic", relation: "organizational_geography",
    }];
    const claim = await issueClaim(client, {
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
    await expect(issueClaim(client, {
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
