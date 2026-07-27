/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { executeGroundxJob } from "./groundxActions";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("../**/*.ts")).map(([path, load]) => [
    path.startsWith("../") ? `./${path.slice(3)}` : `./admin/${path.slice(2)}`,
    load,
  ]),
);

const enqueueJob = makeFunctionReference<"mutation">("admin/jobs:enqueueJob");
const applyProviderResult = makeFunctionReference<"mutation">(
  "admin/jobs:applyProviderResult",
);
const claimJob = makeFunctionReference<"mutation">("admin/jobs:claimJob");
const recordProviderFailure = makeFunctionReference<"mutation">(
  "admin/jobs:recordProviderFailure",
);
const completeGroundxCallback = makeFunctionReference<"mutation">(
  "admin/jobs:completeGroundxCallback",
);
const reconcileStaleJobs = makeFunctionReference<"mutation">(
  "admin/jobs:reconcileStaleJobs",
);

const actor = {
  id: "admin_01",
  roles: ["super_admin"],
};

function request(overrides: Record<string, unknown> = {}) {
  return {
    type: "ingest_remote",
    targetType: "documentVersion",
    targetId: "version_01",
    payload: {
      documents: [{ bucketId: 17, sourceUrl: "https://law.example/doc.pdf" }],
    },
    idempotencyKey: "publish-version-01",
    actor,
    ...overrides,
  };
}

describe("durable GroundX jobs", () => {
  it("collapses concurrent identical enqueue attempts into one job", async () => {
    const t = convexTest(schema, modules);
    const [first, second] = await Promise.all([
      t.mutation(enqueueJob, request()),
      t.mutation(enqueueJob, request()),
    ]);

    expect(second.jobId).toBe(first.jobId);
    expect([first.callbackToken, second.callbackToken].filter(Boolean)).toHaveLength(1);
    expect(
      await t.run(async (ctx) => ctx.db.query("integrationJobs").take(3)),
    ).toHaveLength(1);
  });

  it("rejects idempotency reuse with a different request fingerprint", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(enqueueJob, request());

    await expect(
      t.mutation(
        enqueueJob,
        request({ payload: { documents: [{ bucketId: 18, sourceUrl: "https://law.example/doc.pdf" }] } }),
      ),
    ).rejects.toThrow("INTEGRATION_IDEMPOTENCY_CONFLICT");
  });

  it("bounds and sanitizes persisted payload and actor snapshots", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(enqueueJob, request({ payload: { apiToken: "never-store-me" } })),
    ).rejects.toThrow("INTEGRATION_PAYLOAD_UNSAFE");
    await expect(
      t.mutation(enqueueJob, request({ payload: { value: "x".repeat(8_193) } })),
    ).rejects.toThrow("INTEGRATION_PAYLOAD_TOO_LARGE");

    const created = await t.mutation(enqueueJob, request());
    const snapshot = await t.run(async (ctx) => ({
      jobs: await ctx.db.query("integrationJobs").take(2),
      audits: await ctx.db.query("auditEvents").take(4),
    }));
    const persisted = JSON.stringify(snapshot);
    expect(persisted).not.toContain(created.callbackToken);
    expect(persisted).not.toContain("never-store-me");
    expect(snapshot.jobs[0]).toMatchObject({ actorId: actor.id, actorRoles: actor.roles });
    expect(snapshot.audits).toHaveLength(1);
    expect(snapshot.audits[0].correlationId).toBe(snapshot.jobs[0].correlationId);
  });

  it("enforces legal transitions and shares completion semantics", async () => {
    const t = convexTest(schema, modules);
    const created = await t.mutation(enqueueJob, request());

    await expect(
      t.mutation(completeGroundxCallback, {
        tokenHash: created.callbackTokenHash,
        processId: "process-1",
        targetType: "documentVersion",
        targetId: "version_01",
        status: "complete",
      }),
    ).rejects.toThrow("INTEGRATION_CALLBACK_NOT_READY");

    await expect(
      t.mutation(applyProviderResult, {
        jobId: created.jobId,
        processId: "process-1",
        status: "processing",
      }),
    ).rejects.toThrow("INTEGRATION_TRANSITION_INVALID");
    await expect(
      t.mutation(recordProviderFailure, {
        jobId: created.jobId,
        kind: "network",
      }),
    ).rejects.toThrow("INTEGRATION_TRANSITION_INVALID");
    await t.mutation(claimJob, { jobId: created.jobId });
    await t.mutation(applyProviderResult, {
      jobId: created.jobId,
      processId: "process-1",
      status: "processing",
    });
    const accepted = await t.mutation(completeGroundxCallback, {
      tokenHash: created.callbackTokenHash,
      processId: "process-1",
      targetType: "documentVersion",
      targetId: "version_01",
      status: "complete",
    });
    expect(accepted).toEqual({ accepted: true, duplicate: false });
    await expect(
      t.mutation(completeGroundxCallback, {
        tokenHash: created.callbackTokenHash,
        processId: "process-1",
        targetType: "documentVersion",
        targetId: "version_01",
        status: "complete",
      }),
    ).resolves.toEqual({ accepted: true, duplicate: true });
    await expect(
      t.mutation(applyProviderResult, {
        jobId: created.jobId,
        processId: "process-1",
        status: "complete",
      }),
    ).resolves.toEqual({ accepted: true, duplicate: true });
  });

  it("retries transport and rate-limit failures at 1, 5, and 20 minutes then requires review", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T00:00:00Z"));
    try {
      const t = convexTest(schema, modules);
      const created = await t.mutation(enqueueJob, request());
      const delays = [60_000, 300_000, 1_200_000];
      for (let index = 0; index < delays.length; index += 1) {
        await t.mutation(claimJob, { jobId: created.jobId });
        const now = Date.now();
        const result = await t.mutation(recordProviderFailure, {
          jobId: created.jobId,
          kind: index === 1 ? "rate_limit" : "network",
        });
        expect(result).toMatchObject({ status: "queued", nextAttemptAt: now + delays[index] });
        vi.advanceTimersByTime(delays[index]);
      }
      await t.mutation(claimJob, { jobId: created.jobId });
      await expect(
        t.mutation(recordProviderFailure, { jobId: created.jobId, kind: "timeout" }),
      ).resolves.toMatchObject({ status: "manual_review", nextAttemptAt: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails non-retryable provider errors without scheduling another attempt", async () => {
    const t = convexTest(schema, modules);
    const created = await t.mutation(enqueueJob, request());
    await t.mutation(claimJob, { jobId: created.jobId });
    await expect(
      t.mutation(recordProviderFailure, { jobId: created.jobId, kind: "validation" }),
    ).resolves.toEqual({ status: "failed", nextAttemptAt: null });
  });

  it("uses the typed adapter retryability decision for provider failures", async () => {
    const t = convexTest(schema, modules);
    const terminal = await t.mutation(
      enqueueJob,
      request({ targetId: "terminal-provider", idempotencyKey: "terminal-provider" }),
    );
    await t.mutation(claimJob, { jobId: terminal.jobId });
    await expect(
      t.mutation(recordProviderFailure, {
        jobId: terminal.jobId,
        kind: "provider",
        retryable: false,
      }),
    ).resolves.toEqual({ status: "failed", nextAttemptAt: null });

    const retry = await t.mutation(
      enqueueJob,
      request({ targetId: "retry-provider", idempotencyKey: "retry-provider" }),
    );
    await t.mutation(claimJob, { jobId: retry.jobId });
    await expect(
      t.mutation(recordProviderFailure, {
        jobId: retry.jobId,
        kind: "provider",
        retryable: true,
      }),
    ).resolves.toMatchObject({ status: "queued" });
  });

  it("rejects callback token, process, target, and body mismatches and accepts replay", async () => {
    const t = convexTest(schema, modules);
    const created = await t.mutation(enqueueJob, request());
    await t.mutation(claimJob, { jobId: created.jobId });
    await t.mutation(applyProviderResult, {
      jobId: created.jobId,
      processId: "process-7",
      status: "processing",
    });

    expect(
      (await t.fetch("/groundx/callback/wrong-token", {
        method: "POST",
        body: JSON.stringify({ processId: "process-7", targetType: "documentVersion", targetId: "version_01", status: "complete" }),
      })).status,
    ).toBe(404);
    expect(
      (await t.fetch(`/groundx/callback/${created.callbackToken}`, {
        method: "POST",
        body: JSON.stringify({ processId: "other", targetType: "documentVersion", targetId: "version_01", status: "complete" }),
      })).status,
    ).toBe(404);
    expect(
      (await t.fetch(`/groundx/callback/${created.callbackToken}`, {
        method: "POST",
        body: JSON.stringify({ processId: "process-7", targetType: "documentVersion", targetId: "wrong-target", status: "complete" }),
      })).status,
    ).toBe(404);
    expect(
      (await t.fetch(`/groundx/callback/${created.callbackToken}`, {
        method: "POST",
        body: "x".repeat(16_385),
      })).status,
    ).toBe(400);
    const body = JSON.stringify({ processId: "process-7", targetType: "documentVersion", targetId: "version_01", status: "complete" });
    expect((await t.fetch(`/groundx/callback/${created.callbackToken}`, { method: "POST", body })).status).toBe(202);
    expect((await t.fetch(`/groundx/callback/${created.callbackToken}`, { method: "POST", body })).status).toBe(202);
  }, 20_000);

  it("reconciles only due stale jobs in bounded batches", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T00:00:00Z"));
    try {
      const t = convexTest(schema, modules);
      for (let index = 0; index < 30; index += 1) {
        const created = await t.mutation(
          enqueueJob,
          request({ targetId: `version_${index}`, idempotencyKey: `publish-version-${index}` }),
        );
        await t.run(async (ctx) => ctx.db.patch(created.jobId, { nextAttemptAt: Date.now() - 1 }));
      }
      const future = await t.mutation(
        enqueueJob,
        request({ targetId: "future", idempotencyKey: "publish-version-future" }),
      );
      await t.run(async (ctx) => ctx.db.patch(future.jobId, { nextAttemptAt: Date.now() + 1 }));

      expect(await t.mutation(reconcileStaleJobs, {})).toEqual({ scheduled: 25, hasMore: true });
      const state = await t.run(async (ctx) => ctx.db.get(future.jobId as Id<"integrationJobs">));
      expect(state?.nextAttemptAt).toBe(Date.now() + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers due running and waiting-callback jobs without touching the exact future boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T00:00:00Z"));
    try {
      const t = convexTest(schema, modules);
      const running = await t.mutation(enqueueJob, request({ targetId: "running", idempotencyKey: "publish-running" }));
      const waiting = await t.mutation(enqueueJob, request({ targetId: "waiting", idempotencyKey: "publish-waiting" }));
      const future = await t.mutation(enqueueJob, request({ targetId: "not-due", idempotencyKey: "publish-not-due" }));
      await t.run(async (ctx) => {
        await ctx.db.patch(running.jobId, { status: "running", nextAttemptAt: Date.now() - 1 });
        await ctx.db.patch(waiting.jobId, { status: "waiting_callback", processId: "process-waiting", nextAttemptAt: Date.now() });
        await ctx.db.patch(future.jobId, { status: "running", nextAttemptAt: Date.now() + 1 });
      });

      expect(await t.mutation(reconcileStaleJobs, {})).toEqual({ scheduled: 2, hasMore: false });
      await expect(t.run(async (ctx) => ctx.db.get(running.jobId))).resolves.toMatchObject({ status: "queued" });
      await expect(t.run(async (ctx) => ctx.db.get(future.jobId))).resolves.toMatchObject({ status: "running" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispatches a job through the typed adapter boundary without network access", async () => {
    const t = convexTest(schema, modules);
    const created = await t.mutation(enqueueJob, request());
    const job = await t.run(async (ctx) => ctx.db.get(created.jobId as Id<"integrationJobs">));
    if (!job) throw new Error("missing fixture job");
    const adapter = {
      createBucket: vi.fn(),
      ingestRemote: vi.fn(async () => ({ processId: "process-mock", status: "processing" as const })),
      copyDocuments: vi.fn(),
      deleteDocuments: vi.fn(),
      getProcess: vi.fn(),
    };

    await expect(executeGroundxJob(adapter, job)).resolves.toEqual({ processId: "process-mock", status: "processing" });
    expect(adapter.ingestRemote).toHaveBeenCalledWith({
      documents: [{ bucketId: 17, sourceUrl: "https://law.example/doc.pdf" }],
    });
  });
});
