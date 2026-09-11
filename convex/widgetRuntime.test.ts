import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createWidgetBackend, seedPublicWidget } from "./widgetTestHelpers.fixture";
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
