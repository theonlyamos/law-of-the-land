import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createWidgetBackend, seedPublicWidget, seedGeographicWidget } from "./widgetTestHelpers.fixture";
import { createOpaqueTelemetryToken, hashOpaqueTelemetryValue } from "./lib/telemetryProof";
import type { Admission } from "./widgetRuntime";
import { CHAT_NO_EVIDENCE } from "./lib/chatNoEvidence";

const sessionRef = makeFunctionReference<"mutation">("widgetRuntime:createSession");
const beginRef = makeFunctionReference<"mutation">("widgetRuntime:beginTurn");
const cancelRef = makeFunctionReference<"mutation">("widgetRuntime:cancelTurn");
const finishRef = makeFunctionReference<"mutation">("widgetRuntime:finishTurn");
const readRef = makeFunctionReference<"mutation">("widgetRuntime:readTurn");
beforeEach(() => vi.stubEnv("WIDGET_CHAT_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());
async function fixture() {
  const t = createWidgetBackend(), f = await seedPublicWidget(t), tokenHash = await hashOpaqueTelemetryValue(createOpaqueTelemetryToken());
  const input = { publicId: f.publicId, tokenHash, ipKey: "fixture-ip", requestId: crypto.randomUUID() };
  await t.mutation(sessionRef, { publicId: f.publicId, tokenHash, ipKey: input.ipKey, parentOrigin: "https://greenfield.example" });
  return { t, f, input };
}
it("grants one execution and debits once, including the last allowance", async () => {
  const { t, f, input } = await fixture();
  await t.run(async ctx => { const a = await ctx.db.query("organizationWidgetAllowances").withIndex("by_organizationId", q => q.eq("organizationId", f.organizationId)).unique(); await ctx.db.patch(a!._id, { dailyLimit: 1 }); });
  const first: Admission = await t.mutation(beginRef, { ...input, query: "How do I join?" });
  expect(first.kind).toBe("admitted");
  const duplicate: Admission = await t.mutation(beginRef, { ...input, query: "How do I join?" });
  expect(duplicate.kind).toBe("existing");
  expect(duplicate).not.toHaveProperty("attemptNonce");
  expect((await t.mutation(beginRef, { ...input, requestId: crypto.randomUUID(), query: "Next question" })).error.code).toBe("ALLOWANCE_EXHAUSTED");
  expect((await t.run(ctx => ctx.db.query("widgetUsageBuckets").take(3))).map(row => row.count)).toEqual([1, 1]);
});
it("keeps cancellation terminal and holds uncertain provider capacity", async () => {
  const { t, input } = await fixture();
  const first: Admission = await t.mutation(beginRef, { ...input, query: "Policy?" });
  if (first.kind !== "admitted") throw new Error("Expected admission");
  expect((await t.mutation(cancelRef, input)).status).toBe("aborted");
  expect((await t.mutation(finishRef, { turnId: first.turnId, attemptNonce: first.attemptNonce, outcome: "completed", answer: CHAT_NO_EVIDENCE, citations: [], providerFinished: false })).status).toBe("aborted");
  expect((await t.mutation(beginRef, { ...input, requestId: crypto.randomUUID(), query: "Again?" })).error.code).toBe("GENERATION_BUSY");
});
it("shares quota across sibling widgets while keeping their stores and citations separate", async () => {
  const t = createWidgetBackend(), first = await seedPublicWidget(t), second = await seedPublicWidget(t);
  await t.run(async ctx => {
    await ctx.db.patch(second.jurisdictionId, { organizationId: first.organizationId, visibility: "members" });
    await ctx.db.patch(second.widgetId, { organizationId: first.organizationId });
    const allowance = await ctx.db.query("organizationWidgetAllowances").withIndex("by_organizationId", q => q.eq("organizationId", first.organizationId)).unique();
    await ctx.db.patch(allowance!._id, { dailyLimit: 2 });
  });
  const turns = [];
  for (const widget of [first, second]) {
    const input = { publicId: widget.publicId, tokenHash: await hashOpaqueTelemetryValue(createOpaqueTelemetryToken()), ipKey: "sibling-ip", requestId: crypto.randomUUID() };
    await t.mutation(sessionRef, { publicId: input.publicId, tokenHash: input.tokenHash, ipKey: input.ipKey, parentOrigin: "https://greenfield.example" });
    const turn: Admission = await t.mutation(beginRef, { ...input, query: "What is the policy?" });
    if (turn.kind !== "admitted") throw new Error("Expected sibling admission");
    expect(turn.authority.store.storeName).toBe(widget.storeName);
    expect(turn.authority.store.jurisdictionId).toBe(widget.jurisdictionId);
    turns.push({ input, turn });
  }
  expect((await t.mutation(beginRef, { ...turns[1].input, requestId: crypto.randomUUID(), query: "Again?" })).error.code).toBe("ALLOWANCE_EXHAUSTED");
  const foreign = await t.mutation(finishRef, { turnId: turns[0].turn.turnId, attemptNonce: turns[0].turn.attemptNonce, outcome: "completed", answer: "Wrong library", citations: [{ jurisdictionId: second.jurisdictionId, resourceId: second.resourceId, versionId: second.versionId, providerStoreName: second.storeName }], providerFinished: true });
  expect(foreign.status).toBe("failed");
  const buckets = await t.run(ctx => ctx.db.query("widgetUsageBuckets").withIndex("by_organizationId_and_bucket", q => q.eq("organizationId", first.organizationId)).take(3));
  expect(buckets.map(row => row.count)).toEqual([2, 2]);
});
it("persists governed completion then revokes stale-library recovery", async () => {
  const { t, f, input } = await fixture();
  const first: Admission = await t.mutation(beginRef, { ...input, query: "Policy?" });
  if (first.kind !== "admitted") throw new Error("Expected admission");
  const done = await t.mutation(finishRef, { turnId: first.turnId, attemptNonce: first.attemptNonce, outcome: "completed", answer: CHAT_NO_EVIDENCE, citations: [], providerFinished: true });
  expect(done.result.answer).toBe(CHAT_NO_EVIDENCE);
  await t.run(ctx => ctx.db.patch(f.jurisdictionId, { contentRevision: 1 }));
  expect((await t.mutation(readRef, input)).error.code).toBe("LIBRARY_CHANGED");
  expect((await t.run(ctx => ctx.db.query("widgetSessions").withIndex("by_tokenHash", q => q.eq("tokenHash", input.tokenHash)).unique()))?.revokedAt).toBeTypeOf("number");
});

it("isolates geographical quotas, persists geographic citations, and revokes changed content", async () => {
  const t = createWidgetBackend(), geo = await seedGeographicWidget(t), other = await seedGeographicWidget(t);
  const org = await seedPublicWidget(t);
  const input = { publicId: geo.publicId, tokenHash: await hashOpaqueTelemetryValue(createOpaqueTelemetryToken()), ipKey: "same-ip", requestId: crypto.randomUUID() };
  await t.run(async ctx => {
    const allowance = await ctx.db.query("organizationWidgetAllowances").withIndex("by_jurisdictionId", q => q.eq("jurisdictionId", geo.jurisdictionId)).unique();
    await ctx.db.patch(allowance!._id, { dailyLimit: 1, maxConcurrent: 1 });
  });
  expect(await t.mutation(sessionRef, { publicId: input.publicId, tokenHash: input.tokenHash, ipKey: input.ipKey, parentOrigin: "https://greenfield.example" })).toHaveProperty("expiresAt");
  const turn: Admission = await t.mutation(beginRef, { ...input, query: "What is the city policy?" });
  if (turn.kind !== "admitted") throw new Error("Expected geographic admission");
  expect(turn.authority.store.kind).toBe("geographic");
  expect(turn.authority.store.jurisdictionId).toBe(geo.jurisdictionId);
  expect(turn.authority.organizationId).toBeUndefined();
  const result = await t.mutation(finishRef, { turnId: turn.turnId, attemptNonce: turn.attemptNonce, outcome: "completed", answer: "The city policy applies.", citations: [{ jurisdictionId: geo.jurisdictionId, resourceId: geo.resourceId, versionId: geo.versionId, providerStoreName: geo.storeName }], providerFinished: true });
  expect(result.result.citations[0].jurisdictionKind).toBe("geographic");
  expect((await t.mutation(beginRef, { ...input, requestId: crypto.randomUUID(), query: "Again?" })).error.code).toBe("ALLOWANCE_EXHAUSTED");
  for (const owner of [other, org]) {
    const next = { publicId: owner.publicId, tokenHash: await hashOpaqueTelemetryValue(createOpaqueTelemetryToken()), ipKey: input.ipKey };
    await t.mutation(sessionRef, { ...next, parentOrigin: "https://greenfield.example" });
    const admitted: Admission = await t.mutation(beginRef, { ...next, requestId: crypto.randomUUID(), query: "Policy?" });
    expect(admitted.kind).toBe("admitted");
    if (admitted.kind === "admitted") {
      const foreign = await t.mutation(finishRef, { turnId: admitted.turnId, attemptNonce: admitted.attemptNonce, outcome: "completed", answer: "Foreign policy", citations: [{ jurisdictionId: geo.jurisdictionId, resourceId: geo.resourceId, versionId: geo.versionId, providerStoreName: geo.storeName }], providerFinished: true });
      expect(foreign.status).toBe("failed");
    }
  }
  const { bumpContentRevision } = await import("./lib/widgetAuthority");
  await t.run(ctx => bumpContentRevision(ctx, geo.jurisdictionId));
  expect((await t.mutation(readRef, input)).error.code).toBe("LIBRARY_CHANGED");
});

for (const [kind, seed] of [["organizational", seedPublicWidget], ["geographic", seedGeographicWidget]] as const) {
  it(`serves enabled private ${kind} documents only through the widget and revokes ongoing answers`, async () => {
    const t = createWidgetBackend(), f = await seed(t);
    await t.run(ctx => ctx.db.patch(f.jurisdictionId, { visibility: "members" }));
    const config = makeFunctionReference<"query">("widgets:getPublicConfig");
    const publicRead = makeFunctionReference<"query">("jurisdictions:getAccessibleById");
    const input = { publicId: f.publicId, tokenHash: await hashOpaqueTelemetryValue(createOpaqueTelemetryToken()), ipKey: "private-test", requestId: crypto.randomUUID() };
    const session = { publicId: input.publicId, tokenHash: input.tokenHash, ipKey: input.ipKey, parentOrigin: "https://greenfield.example" };
    await t.run(ctx => ctx.db.patch(f.widgetId, { enabled: false }));
    expect(await t.query(config, { publicId: f.publicId, parentOrigin: session.parentOrigin })).toBeNull();
    expect((await t.mutation(sessionRef, session)).error.code).toBe("WIDGET_UNAVAILABLE");
    await t.run(ctx => ctx.db.patch(f.widgetId, { enabled: true }));
    expect(await t.query(publicRead, { id: f.jurisdictionId })).toBeNull();
    expect(await t.query(config, { publicId: f.publicId, parentOrigin: "https://attacker.example" })).toBeNull();
    expect(await t.query(config, { publicId: f.publicId, parentOrigin: session.parentOrigin })).not.toBeNull();
    await t.mutation(sessionRef, session);
    const turn: Admission = await t.mutation(beginRef, { ...input, query: "Policy?" });
    if (turn.kind !== "admitted") throw new Error("Expected private widget admission");
    const citation = { jurisdictionId: f.jurisdictionId, resourceId: f.resourceId, versionId: f.versionId, providerStoreName: f.storeName };
    const done = await t.mutation(finishRef, { turnId: turn.turnId, attemptNonce: turn.attemptNonce, outcome: "completed", answer: "Published policy applies.", citations: [citation], providerFinished: true });
    expect(done.result.citations[0].jurisdictionKind).toBe(kind);
    const pending: Admission = await t.mutation(beginRef, { ...input, requestId: crypto.randomUUID(), query: "Another question?" });
    if (pending.kind !== "admitted") throw new Error("Expected second admission");
    await t.run(ctx => ctx.db.patch(f.widgetId, { enabled: false, accessVersion: 1 }));
    expect((await t.mutation(readRef, input)).error.code).toBe("WIDGET_UNAVAILABLE");
    const rejected = await t.mutation(finishRef, { turnId: pending.turnId, attemptNonce: pending.attemptNonce, outcome: "completed", answer: "Must not be released", citations: [citation], providerFinished: true });
    expect(rejected.status).toBe("failed");
    expect(rejected.result).toBeUndefined();
  });
}
