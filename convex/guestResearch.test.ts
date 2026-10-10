import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addAssuredOrganizationUser, createWidgetBackend, seedGeographicWidget, seedPublicWidget } from "./widgetTestHelpers.fixture";
import { createOpaqueTelemetryToken, hashOpaqueTelemetryValue } from "./lib/telemetryProof";
import { CHAT_NO_EVIDENCE } from "./lib/chatNoEvidence";
import type { GuestAdmission } from "./guestResearch";
import { GUEST_RESEARCH_LIFETIME_MS } from "./lib/guestResearchContracts";
import { createWidgetServiceProof } from "./lib/widgetProof";

const sessionRef = makeFunctionReference<"mutation">("guestResearch:createSession");
const readRef = makeFunctionReference<"mutation">("guestResearch:readSession");
const beginRef = makeFunctionReference<"mutation">("guestResearch:beginTurn");
const finishRef = makeFunctionReference<"mutation">("guestResearch:finishTurn");
const adoptRef = makeFunctionReference<"mutation">("guestResearch:adoptSession");
beforeEach(() => vi.stubEnv("GUEST_RESEARCH_ENABLED", "true"));
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

async function fixture() {
  const t = createWidgetBackend(), f = await seedGeographicWidget(t);
  const tokenHash = await hashOpaqueTelemetryValue(createOpaqueTelemetryToken());
  const input = { tokenHash, ipKey: "fixture-ip", requestId: crypto.randomUUID(), query: "What does this law require?" };
  expect(await t.mutation(sessionRef, { tokenHash, ipKey: input.ipKey, jurisdictionId: f.jurisdictionId })).toMatchObject({ remaining: 2, turns: [] });
  return { t, f, input };
}
async function begin(t: ReturnType<typeof createWidgetBackend>, input: { tokenHash: string; ipKey: string; requestId: string; query: string }) {
  const turn: GuestAdmission = await t.mutation(beginRef, input);
  if (turn.kind !== "admitted") throw new Error(JSON.stringify(turn));
  return turn;
}

it("allows exactly two completed answers, replays requests, and excludes failed attempts", async () => {
  const { t, input } = await fixture();
  const failed = await begin(t, input);
  expect(await t.mutation(beginRef, input)).toMatchObject({ kind: "existing", turn: { status: "pending" } });
  expect(await t.mutation(beginRef, { ...input, query: "Changed" })).toMatchObject({ kind: "denied", error: { code: "REQUEST_CONFLICT" } });
  expect(await t.mutation(beginRef, { ...input, requestId: crypto.randomUUID() })).toMatchObject({ kind: "denied", error: { code: "GENERATION_BUSY" } });
  await t.mutation(finishRef, { turnId: failed.turnId, attemptNonce: failed.attemptNonce, outcome: "failed", citations: [], providerFinished: true });
  expect(await t.mutation(readRef, { tokenHash: input.tokenHash })).toMatchObject({ remaining: 2 });
  for (const remaining of [1, 0]) {
    const request = { ...input, requestId: crypto.randomUUID() }, turn = await begin(t, request);
    await t.mutation(finishRef, { turnId: turn.turnId, attemptNonce: turn.attemptNonce, outcome: "completed", answer: CHAT_NO_EVIDENCE, citations: [], providerFinished: true });
    expect(await t.mutation(beginRef, request)).toMatchObject({ kind: "existing", turn: { status: "completed" } });
    expect(await t.mutation(readRef, { tokenHash: input.tokenHash })).toMatchObject({ remaining });
  }
  expect(await t.mutation(beginRef, { ...input, requestId: crypto.randomUUID() })).toMatchObject({ kind: "denied", error: { code: "TRIAL_EXHAUSTED" } });
});

it("binds restricted guest sessions to the published allowlist and denies legacy admission and completion", async () => {
  vi.stubEnv("ADMIN_ENVIRONMENT", "test");
  const { t, f, input } = await fixture();
  await t.run(async ctx => {
    const original = (await ctx.db.get(f.versionId))!;
    const { _id: _id, _creationTime: _creationTime, ...version } = original;
    const failedId = await ctx.db.insert("documentVersions", { ...version, versionNumber: 2, status: "failed", geminiDocumentName: undefined });
    await ctx.db.patch(f.jurisdictionId, { geminiSearchRestriction: { kind: "published_only", establishedAt: Date.now(), failedVersionIds: [failedId] } });
  });
  expect(await t.mutation(beginRef, input)).toMatchObject({ kind: "denied", error: { code: "WIDGET_UNAVAILABLE" } });
  const capable = { ...input, tokenHash: await hashOpaqueTelemetryValue(createOpaqueTelemetryToken()), publicationFilterProtocol: "published-v1" as const };
  expect(await t.mutation(sessionRef, { tokenHash: capable.tokenHash, ipKey: capable.ipKey, jurisdictionId: f.jurisdictionId,
    publicationFilterProtocol: capable.publicationFilterProtocol })).toMatchObject({ remaining: 2 });
  const admitted = await begin(t, capable);
  expect(admitted.manifest.stores[0].publicationFilter).toEqual({ protocol: "published-v1", environment: "test",
    documents: [{ resourceId: f.resourceId, versionId: f.versionId, sha256: "0".repeat(64) }] });
  expect(await t.mutation(readRef, { tokenHash: capable.tokenHash })).toMatchObject({ error: { code: "WIDGET_UNAVAILABLE" } });
  const denied = await t.mutation(finishRef, { turnId: admitted.turnId, attemptNonce: admitted.attemptNonce,
    outcome: "completed", answer: CHAT_NO_EVIDENCE, citations: [], providerFinished: true });
  expect(denied).toMatchObject({ status: "failed" }); expect(denied.result).toBeUndefined();
  const next = await begin(t, { ...capable, requestId: crypto.randomUUID() });
  expect(await t.mutation(finishRef, { turnId: next.turnId, attemptNonce: next.attemptNonce,
    outcome: "completed", answer: CHAT_NO_EVIDENCE, citations: [], providerFinished: true,
    publicationFilterProtocol: capable.publicationFilterProtocol })).toMatchObject({ status: "completed" });
  await t.run(ctx => ctx.db.patch(f.versionId, { sha256: "b".repeat(64) }));
  expect(await t.mutation(readRef, { tokenHash: capable.tokenHash, publicationFilterProtocol: capable.publicationFilterProtocol }))
    .toMatchObject({ error: { code: "LIBRARY_CHANGED" } });
});

it("uses public ancestors and refuses private jurisdictions even for signed-in members", async () => {
  const { t, f, input } = await fixture(), parent = await seedGeographicWidget(t);
  await t.run(async ctx => {
    const childProfile = await ctx.db.query("geographicJurisdictions").withIndex("by_jurisdictionId", q => q.eq("jurisdictionId", f.jurisdictionId)).unique();
    const parentProfile = await ctx.db.query("geographicJurisdictions").withIndex("by_jurisdictionId", q => q.eq("jurisdictionId", parent.jurisdictionId)).unique();
    await ctx.db.patch(childProfile!._id, { parentJurisdictionId: parent.jurisdictionId });
    await ctx.db.patch(parentProfile!._id, { level: "state" });
  });
  const newToken = await hashOpaqueTelemetryValue(createOpaqueTelemetryToken());
  await t.mutation(sessionRef, { tokenHash: newToken, ipKey: input.ipKey, jurisdictionId: f.jurisdictionId });
  const turn = await begin(t, { ...input, tokenHash: newToken });
  expect(turn.manifest.stores.map(store => store.relation)).toEqual(["selected", "geographic_ancestor"]);
  const privateOrg = await seedPublicWidget(t), user = await addAssuredOrganizationUser(t);
  await t.run(async ctx => {
    await ctx.db.patch(privateOrg.jurisdictionId, { visibility: "members" });
    await ctx.db.insert("organizationMemberships", { organizationId: privateOrg.organizationId, userId: user.userId, role: "member", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
  });
  expect(await user.client.mutation(sessionRef, { tokenHash: await hashOpaqueTelemetryValue(createOpaqueTelemetryToken()), ipKey: "private-ip", jurisdictionId: privateOrg.jurisdictionId })).toMatchObject({ error: { code: "WIDGET_UNAVAILABLE" } });
});

it("revalidates citations, blocks cross-library answers, and atomically adopts only canonical records", async () => {
  const { t, f, input } = await fixture(), foreign = await seedGeographicWidget(t);
  const invalid = await begin(t, input);
  const rejected = await t.mutation(finishRef, { turnId: invalid.turnId, attemptNonce: invalid.attemptNonce, outcome: "completed", answer: "Foreign answer", citations: [{ jurisdictionId: foreign.jurisdictionId, resourceId: foreign.resourceId, versionId: foreign.versionId, providerStoreName: foreign.storeName }], providerFinished: true });
  expect(rejected).toMatchObject({ status: "failed" });
  expect(rejected.result).toBeUndefined();
  const turn = await begin(t, { ...input, requestId: crypto.randomUUID() });
  const citation = { jurisdictionId: f.jurisdictionId, resourceId: f.resourceId, versionId: f.versionId, providerStoreName: f.storeName };
  expect(await t.mutation(finishRef, { turnId: turn.turnId, attemptNonce: turn.attemptNonce, outcome: "completed", answer: "The published rule applies.", citations: [citation], providerFinished: true })).toMatchObject({ status: "completed", result: { citations: [{ issuer: "Greenfield", officialCitation: "Policy 1" }] } });
  expect(await t.mutation(adoptRef, { tokenHash: input.tokenHash })).toMatchObject({ error: { code: "AUTH_REQUIRED" } });
  const owner = await addAssuredOrganizationUser(t), other = await addAssuredOrganizationUser(t);
  const adopted = await owner.client.mutation(adoptRef, { tokenHash: input.tokenHash });
  expect(adopted.chatId).toMatch(/^[a-f0-9-]{36}$/);
  expect(await owner.client.mutation(adoptRef, { tokenHash: input.tokenHash })).toEqual(adopted);
  expect(await other.client.mutation(adoptRef, { tokenHash: input.tokenHash })).toMatchObject({ error: { code: "SESSION_INVALID" } });
  expect(await t.mutation(beginRef, { ...input, requestId: crypto.randomUUID() })).toMatchObject({ kind: "denied", error: { code: "TRIAL_EXHAUSTED" } });
  const saved = await t.run(async ctx => {
    const chats = await ctx.db.query("chatSessions").withIndex("by_user", q => q.eq("userId", owner.userId)).take(2);
    const messages = await ctx.db.query("messages").withIndex("by_session", q => q.eq("sessionId", chats[0]._id)).take(5);
    return { chats, messages };
  });
  expect(saved.chats).toHaveLength(1);
  expect(saved.chats[0]).toMatchObject({ jurisdictionContract: "unified", messageCount: 2 });
  expect(saved.messages.map(message => message.role)).toEqual(["user", "assistant"]);
  expect(saved.messages[1]).toMatchObject({ content: "The published rule applies.", answerKind: "legal", citations: [{ jurisdictionId: f.jurisdictionId, label: "Membership policy" }] });
  const expectedSources = [{ label: "Membership policy", jurisdictionId: f.jurisdictionId, jurisdictionName: "Greenfield", jurisdictionKind: "geographic", relation: "selected", issuer: "Greenfield", officialCitation: "Policy 1", effectiveDate: "2026-01-01", sourceUrl: "https://greenfield.example/policy" }];
  expect(saved.messages[1].guestSources).toEqual(expectedSources);
  const listed = await owner.client.query(makeFunctionReference<"query">("chats:listMessages"), { externalId: adopted.chatId, paginationOpts: { numItems: 10, cursor: null } });
  expect(listed.page[1].guestSources).toEqual(expectedSources);
  await expect(owner.client.mutation(makeFunctionReference<"mutation">("chats:appendMessages"), {
    externalId: adopted.chatId, lastMessage: "Forged", messages: [{ role: "user", content: "Forged", guestSources: expectedSources }],
  })).rejects.toThrow();
  await t.run(ctx => ctx.db.patch(f.versionId, { status: "superseded" }));
  expect(await t.mutation(readRef, { tokenHash: input.tokenHash })).toHaveProperty("error");
});

it("keeps a failed provider lease until expiry and rejects late completion without using an answer", async () => {
  const { t, input } = await fixture();
  const turn = await begin(t, input);
  await t.mutation(finishRef, { turnId: turn.turnId, attemptNonce: turn.attemptNonce, outcome: "aborted", citations: [], providerFinished: false });
  expect(await t.mutation(beginRef, { ...input, requestId: crypto.randomUUID() })).toMatchObject({ kind: "denied", error: { code: "GENERATION_BUSY" } });
  await t.run(ctx => ctx.db.patch(turn.turnId, { leaseExpiresAt: Date.now() - 1 }));
  const next = await begin(t, { ...input, requestId: crypto.randomUUID() });
  await t.run(ctx => ctx.db.patch(next.turnId, { leaseExpiresAt: Date.now() - 1 }));
  expect(await t.mutation(readRef, { tokenHash: input.tokenHash })).toMatchObject({ remaining: 2, turns: [{ status: "aborted" }, { status: "failed" }] });
  expect(await t.mutation(finishRef, { turnId: next.turnId, attemptNonce: next.attemptNonce, outcome: "completed", answer: CHAT_NO_EVIDENCE, citations: [], providerFinished: true })).toMatchObject({ status: "failed" });
});

it("enforces a durable platform request budget across independent sessions", async () => {
  vi.stubEnv("GUEST_RESEARCH_DAILY_BUDGET", "1");
  const { t, f, input } = await fixture();
  await begin(t, input);
  const tokenHash = await hashOpaqueTelemetryValue(createOpaqueTelemetryToken());
  await t.mutation(sessionRef, { tokenHash, ipKey: "other-ip", jurisdictionId: f.jurisdictionId });
  expect(await t.mutation(beginRef, { ...input, tokenHash, ipKey: "other-ip" })).toMatchObject({ kind: "denied", error: { code: "ALLOWANCE_EXHAUSTED" } });
  expect(await t.mutation(readRef, { tokenHash })).toMatchObject({ remaining: 2 });
});

it("shares question throttling across sessions on the same IP", async () => {
  const { t, f, input } = await fixture();
  await t.run(ctx => ctx.db.insert("widgetRateBuckets", { namespace: "guest-questions", key: input.ipKey, window: Math.floor(Date.now() / 3600000), count: 10, expiresAt: (Math.floor(Date.now() / 3600000) + 1) * 3600000 }));
  const tokenHash = await hashOpaqueTelemetryValue(createOpaqueTelemetryToken());
  await t.mutation(sessionRef, { tokenHash, ipKey: input.ipKey, jurisdictionId: f.jurisdictionId });
  expect(await t.mutation(beginRef, { ...input, tokenHash })).toMatchObject({ kind: "denied", error: { code: "RATE_LIMITED" } });
  expect(await t.mutation(readRef, { tokenHash })).toMatchObject({ remaining: 2 });
});

it("requires operation-bound service proof for the bridge and auth for adoption", async () => {
  vi.stubEnv("EMBED_SERVICE_SECRET", "test-only-guest-proof-".repeat(3));
  const { t, input } = await fixture();
  const body = JSON.stringify({ tokenHash: input.tokenHash }), issuedAt = Date.now();
  const signature = await createWidgetServiceProof("guest-read", issuedAt, new TextEncoder().encode(body));
  const headers = { "content-type": "application/json", "x-widget-issued-at": String(issuedAt), "x-widget-signature": signature };
  expect((await t.fetch("/private/guest-research/read", { method: "POST", body })).status).toBe(401);
  const response = await t.fetch("/private/guest-research/read", { method: "POST", headers, body });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ remaining: 2 });
  expect((await t.fetch("/private/guest-research/adopt", { method: "POST", headers, body })).status).toBe(401);
  const adoptionSignature = await createWidgetServiceProof("guest-adopt", issuedAt, new TextEncoder().encode(body));
  expect((await t.fetch("/private/guest-research/adopt", { method: "POST", headers: { ...headers, "x-widget-signature": adoptionSignature }, body })).status).toBe(401);
});

it("expires guest sessions after 24 hours and gates all anonymous entry points", async () => {
  const { t, input } = await fixture();
  const state = await t.mutation(readRef, { tokenHash: input.tokenHash });
  expect(state.expiresAt - Date.now()).toBeGreaterThan(GUEST_RESEARCH_LIFETIME_MS - 5000);
  await t.run(async ctx => {
    const row = await ctx.db.query("guestResearchSessions").withIndex("by_tokenHash", q => q.eq("tokenHash", input.tokenHash)).unique();
    await ctx.db.patch(row!._id, { expiresAt: Date.now() - 1 });
  });
  expect(await t.mutation(readRef, { tokenHash: input.tokenHash })).toMatchObject({ error: { code: "SESSION_EXPIRED" } });
  vi.stubEnv("GUEST_RESEARCH_ENABLED", "false");
  expect(await t.mutation(beginRef, input)).toMatchObject({ kind: "denied", error: { code: "WIDGET_UNAVAILABLE" } });
});
