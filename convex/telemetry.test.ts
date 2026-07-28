/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { components } from "./_generated/api";
import authSchema from "./betterAuth/schema";
import schema from "./schema";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.ts")).map(([path, load]) => [path, load]),
);
const authModules = Object.fromEntries(
  Object.entries(import.meta.glob("./betterAuth/**/*.ts")).map(([path, load]) => [
    `./${path.slice("./betterAuth/".length)}`,
    load,
  ]),
);
type Backend = TestConvex<typeof schema>;

const issue = makeFunctionReference<"mutation">("telemetry:issueCorrelation");
const searchPhase = makeFunctionReference<"mutation">("telemetry:recordSearchPhase");
const claim = makeFunctionReference<"mutation">("telemetry:claimChatPhase");
const finalize = makeFunctionReference<"mutation">("telemetry:finalizeChatPhase");
const expire = makeFunctionReference<"mutation">("telemetry:finalizeExpiredCorrelation");
const rollup = makeFunctionReference<"mutation">("telemetry:rollupDailyMetrics");
const list = makeFunctionReference<"query">("admin/analytics:listDailyMetrics");

const SECRET = "telemetry-test-secret-with-at-least-32-characters";

function backend() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  return t;
}

function b64url(bytes: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function proof(parts: readonly (string | number)[]) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64url(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(parts.map((part) => `${String(part).length}:${part}`).join("|")),
    ),
  );
}

async function user(t: Backend, label: string) {
  const now = Date.now();
  const created = await t.run((ctx) =>
    ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          name: label,
          email: `${label}-${crypto.randomUUID()}@example.test`,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
          role: "user",
          banned: false,
          twoFactorEnabled: false,
        },
      },
    }),
  );
  const session = await t.run((ctx) =>
    ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "session",
        data: {
          token: crypto.randomUUID(),
          userId: created._id,
          expiresAt: now + 86_400_000,
          createdAt: now,
          updatedAt: now,
        },
      },
    }),
  );
  return {
    userId: created._id,
    sessionId: session._id,
    client: t.withIdentity({ subject: created._id, sessionId: session._id }),
  };
}

async function admin(t: Backend, role = "auditor") {
  const now = Date.now();
  const created = await t.run((ctx) =>
    ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          name: "Analytics administrator",
          email: `${crypto.randomUUID()}@example.test`,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
          role,
          banned: false,
          twoFactorEnabled: true,
        },
      },
    }),
  );
  const session = await t.run((ctx) =>
    ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "session",
        data: {
          token: crypto.randomUUID(),
          userId: created._id,
          expiresAt: now + 86_400_000,
          createdAt: now,
          updatedAt: now,
          adminTwoFactorVerifiedAt: now,
        },
      },
    }),
  );
  return t.withIdentity({ subject: created._id, sessionId: session._id });
}

async function jurisdiction(t: Backend, code = "GH") {
  const now = Date.now();
  await t.run((ctx) =>
    ctx.db.insert("jurisdictions", {
      code,
      name: code === "GH" ? "Ghana" : "Nigeria",
      slug: code.toLowerCase(),
      status: "enabled",
      isDefault: code === "GH",
      productionBucketId: "11833",
      providerSyncState: "synced",
      createdBy: "fixture",
      updatedBy: "fixture",
      createdAt: now,
      updatedAt: now,
    }),
  );
}

async function issueFor(
  client: ReturnType<Backend["withIdentity"]>,
  token: string,
  code = "GH",
) {
  return client.mutation(issue, {
    token,
    jurisdictionCode: code,
    serviceProof: await proof(["issue", token, code]),
  });
}

async function recordSearch(
  client: ReturnType<Backend["withIdentity"]>,
  token: string,
  status: "success" | "no_result" | "failure" = "success",
) {
  const args = {
    token,
    providerStatus: status,
    latencyMs: 125,
    resultCount: status === "success" ? 3 : 0,
  } as const;
  return client.mutation(searchPhase, {
    ...args,
    serviceProof: await proof([
      "search",
      token,
      args.providerStatus,
      args.latencyMs,
      args.resultCount,
    ]),
  });
}

const previous = {
  secret: process.env.TELEMETRY_INGEST_SECRET,
  panel: process.env.ADMIN_PANEL_ENABLED,
  environment: process.env.ADMIN_ENVIRONMENT,
};

beforeEach(() => {
  process.env.TELEMETRY_INGEST_SECRET = SECRET;
});

afterEach(() => {
  vi.useRealTimers();
  for (const [key, value] of Object.entries(previous)) {
    const env = key === "secret" ? "TELEMETRY_INGEST_SECRET" : key === "panel" ? "ADMIN_PANEL_ENABLED" : "ADMIN_ENVIRONMENT";
    if (value === undefined) delete process.env[env]; else process.env[env] = value;
  }
});

describe("privacy-bounded query telemetry", () => {
  it("stores only a compact terminal outcome and no question, context, answer, token, or provider error", async () => {
    const t = backend();
    await jurisdiction(t);
    const owner = await user(t, "owner");
    const token = b64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
    await issueFor(owner.client, token);
    await recordSearch(owner.client, token);
    const claimed = await owner.client.mutation(claim, {
      token,
      jurisdictionCode: "GH",
      serviceProof: await proof(["claim", token, "GH"]),
    });
    await owner.client.mutation(finalize, {
      token,
      claimNonce: claimed.claimNonce,
      providerStatus: "success",
      latencyMs: 250,
      serviceProof: await proof(["finalize", token, claimed.claimNonce, "success", 250]),
    });

    const runs = await t.run((ctx) => ctx.db.query("queryRuns").take(2));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      jurisdictionCode: "GH",
      outcome: "success",
      searchProviderStatus: "success",
      generationProviderStatus: "success",
      searchLatencyMs: 125,
      generationLatencyMs: 250,
      totalLatencyMs: 375,
      resultCount: 3,
    });
    for (const forbidden of ["query", "prompt", "context", "answer", "chat", "error", "token", "ownerId", "sessionId"]) {
      expect(runs[0]).not.toHaveProperty(forbidden);
    }
    expect(JSON.stringify(runs[0])).not.toContain(token);
  });

  it("rejects forged proofs, cross-user/session ownership, wrong jurisdiction, expiry, and replay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T12:00:00.000Z"));
    const t = backend();
    await jurisdiction(t);
    await jurisdiction(t, "NG");
    const owner = await user(t, "owner");
    const attacker = await user(t, "attacker");
    const token = b64url(crypto.getRandomValues(new Uint8Array(32)).buffer);

    await expect(owner.client.mutation(issue, { token, jurisdictionCode: "GH", serviceProof: "forged" })).rejects.toThrow("TELEMETRY_SERVICE_PROOF_INVALID");
    await issueFor(owner.client, token);
    await recordSearch(owner.client, token);
    await expect(attacker.client.mutation(claim, { token, jurisdictionCode: "GH", serviceProof: await proof(["claim", token, "GH"]) })).rejects.toThrow("TELEMETRY_CORRELATION_FORBIDDEN");
    await expect(owner.client.mutation(claim, { token, jurisdictionCode: "NG", serviceProof: await proof(["claim", token, "NG"]) })).rejects.toThrow("TELEMETRY_JURISDICTION_MISMATCH");

    const claimed = await owner.client.mutation(claim, { token, jurisdictionCode: "GH", serviceProof: await proof(["claim", token, "GH"]) });
    await expect(owner.client.mutation(claim, { token, jurisdictionCode: "GH", serviceProof: await proof(["claim", token, "GH"]) })).rejects.toThrow("TELEMETRY_CORRELATION_REPLAYED");
    vi.setSystemTime(new Date(Date.now() + 3 * 60_000));
    await owner.client.mutation(expire, { tokenHash: claimed.correlationId });
    await expect(owner.client.mutation(finalize, { token, claimNonce: claimed.claimNonce, providerStatus: "success", latencyMs: 10, serviceProof: await proof(["finalize", token, claimed.claimNonce, "success", 10]) })).rejects.toThrow("TELEMETRY_CORRELATION_EXPIRED");
    const runs = await t.run((ctx) => ctx.db.query("queryRuns").take(2));
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe("aborted");
  });

  it("records exactly one failure when search fails and one abort when chat never finishes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T12:00:00.000Z"));
    const t = backend();
    await jurisdiction(t);
    const owner = await user(t, "owner");
    const failedToken = b64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
    await issueFor(owner.client, failedToken);
    await recordSearch(owner.client, failedToken, "failure");
    await expect(recordSearch(owner.client, failedToken, "failure")).rejects.toThrow("TELEMETRY_CORRELATION_REPLAYED");

    const abandonedToken = b64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
    await issueFor(owner.client, abandonedToken);
    await recordSearch(owner.client, abandonedToken);
    vi.setSystemTime(new Date(Date.now() + 6 * 60_000));
    const grant = await t.run((ctx) => ctx.db.query("telemetryCorrelations").withIndex("by_status_and_expiresAt", (q) => q.eq("status", "search_complete")).first());
    await owner.client.mutation(expire, { tokenHash: grant!.tokenHash });
    await owner.client.mutation(expire, { tokenHash: grant!.tokenHash });

    const runs = await t.run((ctx) => ctx.db.query("queryRuns").take(10));
    expect(runs).toHaveLength(2);
    expect(runs.map((row) => row.outcome).sort()).toEqual(["aborted", "failure"]);
  });
});

describe("daily telemetry rollups", () => {
  it("processes at most 500 rows, resumes immediately, and cannot double count retries or concurrency", async () => {
    const t = backend();
    await t.run(async (ctx) => {
      for (let index = 0; index < 501; index += 1) {
        await ctx.db.insert("queryRuns", {
          correlationId: `run-${index}`,
          day: "2026-07-28",
          jurisdictionCode: index % 2 === 0 ? "GH" : "NG",
          outcome: index % 10 === 0 ? "failure" : "success",
          searchProviderStatus: index % 11 === 0 ? "no_result" : "success",
          generationProviderStatus: index % 10 === 0 ? "failure" : "success",
          searchLatencyMs: 100,
          generationLatencyMs: 200,
          totalLatencyMs: index === 500 ? 6_000 : 300,
          resultCount: index % 11 === 0 ? 0 : 2,
          completedAt: Date.parse("2026-07-28T23:59:59.999Z"),
          rollupStatus: "pending",
        });
      }
    });

    const first = await t.mutation(rollup, { cursor: null });
    expect(first).toMatchObject({ processed: 500, done: false });
    expect(first.cursor).toEqual(expect.any(String));
    const concurrent = await Promise.all([
      t.mutation(rollup, { cursor: first.cursor }),
      t.mutation(rollup, { cursor: first.cursor }),
    ]);
    expect(concurrent.reduce((sum, row) => sum + row.processed, 0)).toBe(1);
    expect((await t.mutation(rollup, { cursor: first.cursor })).processed).toBe(0);

    const metrics = await t.run((ctx) => ctx.db.query("dailyMetrics").take(10));
    expect(metrics.reduce((sum, row) => sum + row.totalQuestions, 0)).toBe(501);
    expect(metrics.reduce((sum, row) => sum + row.providerFailureCount, 0)).toBe(51);
    expect(metrics.reduce((sum, row) => sum + row.noResultCount, 0)).toBe(46);
    expect(metrics.find((row) => row.jurisdictionCode === "GH")?.latencyGt5000).toBe(1);
  });

  it("uses UTC terminal days and derives percentile bounds from persisted histograms", async () => {
    const t = backend();
    await t.run(async (ctx) => {
      for (const [index, latency] of [100, 200, 400, 900, 2_000, 6_000].entries()) {
        const completedAt = index === 0 ? Date.parse("2026-07-28T23:59:59.999Z") : Date.parse("2026-07-29T00:00:00.000Z");
        await ctx.db.insert("queryRuns", {
          correlationId: `boundary-${index}`,
          day: new Date(completedAt).toISOString().slice(0, 10),
          jurisdictionCode: "GH",
          outcome: "success",
          searchProviderStatus: "success",
          generationProviderStatus: "success",
          searchLatencyMs: 0,
          generationLatencyMs: latency,
          totalLatencyMs: latency,
          resultCount: 1,
          completedAt,
          rollupStatus: "pending",
        });
      }
    });
    await t.mutation(rollup, { cursor: null });
    const metrics = await t.run((ctx) => ctx.db.query("dailyMetrics").withIndex("by_day", (q) => q.gte("day", "2026-07-28").lte("day", "2026-07-29")).take(3));
    expect(metrics.map((row) => [row.day, row.totalQuestions])).toEqual([["2026-07-28", 1], ["2026-07-29", 5]]);
    expect(metrics[1]).toMatchObject({ p50LatencyMs: 1000, p95LatencyMs: 6000 });
  });
});

describe("admin analytics", () => {
  it("requires assured analytics permission and reads only paginated daily aggregates", async () => {
    const t = backend();
    process.env.ADMIN_PANEL_ENABLED = "true";
    process.env.ADMIN_ENVIRONMENT = "test";
    await t.run(async (ctx) => {
      await ctx.db.insert("featureFlags", { key: "admin_panel", environment: "test", enabled: true, updatedAt: Date.now() });
      await ctx.db.insert("dailyMetrics", {
        day: "2026-07-28", jurisdictionCode: "GH", totalQuestions: 7, successCount: 6, failureCount: 1, abortedCount: 0, providerFailureCount: 1, noResultCount: 2,
        latencyLe250: 1, latencyLe500: 2, latencyLe1000: 2, latencyLe2500: 1, latencyLe5000: 1, latencyGt5000: 0, p50LatencyMs: 1000, p95LatencyMs: 5000, updatedAt: Date.now(),
      });
      await ctx.db.insert("queryRuns", { correlationId: "raw-run-must-not-leak", day: "2026-07-28", jurisdictionCode: "GH", outcome: "success", searchProviderStatus: "success", generationProviderStatus: "success", searchLatencyMs: 1, generationLatencyMs: 1, totalLatencyMs: 2, resultCount: 99, completedAt: Date.now(), rollupStatus: "pending" });
    });
    const asAuditor = await admin(t);
    const page = await asAuditor.query(list, { paginationOpts: { numItems: 1, cursor: null }, jurisdictionCode: null, fromDay: "2026-07-01", toDay: "2026-07-31" });
    expect(page.page).toEqual([expect.objectContaining({ totalQuestions: 7, p95LatencyMs: 5000 })]);
    expect(JSON.stringify(page)).not.toContain("raw-run-must-not-leak");
    await expect((await admin(t, "support_agent")).query(list, { paginationOpts: { numItems: 1, cursor: null }, jurisdictionCode: null, fromDay: "2026-07-01", toDay: "2026-07-31" })).rejects.toThrow("permission");
  });
});
