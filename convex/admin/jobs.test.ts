/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { components } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import authSchema from "../betterAuth/schema";
import schema from "../schema";
import { executeClaimedGroundxJob, executeGroundxJob } from "./groundxActions";
import { E2E_PRIVILEGED_FUNCTIONS } from "./e2eAccessMatrix";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("../**/*.ts")).map(([path, load]) => [
    path.startsWith("../") ? `./${path.slice(3)}` : `./admin/${path.slice(2)}`,
    load,
  ]),
);
const authModules = Object.fromEntries(
  Object.entries(import.meta.glob("../betterAuth/**/*.ts")).map(
    ([path, load]) => [`./${path.slice("../betterAuth/".length)}`, load],
  ),
);
type Backend = TestConvex<typeof schema>;

const enqueueJob = makeFunctionReference<"mutation">("admin/jobs:enqueueSystemJob");
const guardedEnqueueJob = makeFunctionReference<"mutation">("admin/jobs:enqueueJob");
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
const armGroundxCallback = makeFunctionReference<"mutation">(
  "admin/jobs:armGroundxCallback",
);
const reconcileStaleJobs = makeFunctionReference<"mutation">(
  "admin/jobs:reconcileStaleJobs",
);
const reconcileManualReviewJob = makeFunctionReference<"mutation">(
  "admin/jobs:reconcileManualReviewJob",
);
const runGroundxJob = makeFunctionReference<"action">("admin/groundxActions:runGroundxJob");

function createBackend() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  return t;
}

async function enablePanel(t: Backend) {
  process.env.ADMIN_PANEL_ENABLED = "true";
  process.env.ADMIN_ENVIRONMENT = "test";
  await t.run(async (ctx) => {
    await ctx.db.insert("featureFlags", {
      key: "admin_panel",
      environment: "test",
      enabled: true,
      updatedAt: Date.now(),
    });
  });
}

async function asAdmin(t: Backend, role: string) {
  const identity = await t.run(async (ctx) => {
    const now = Date.now();
    const user = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          name: `${role} fixture`,
          email: `${role}-${crypto.randomUUID()}@example.com`,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
          role,
          banned: false,
          twoFactorEnabled: true,
        },
      },
    });
    const session = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "session",
        data: {
          token: `session-${crypto.randomUUID()}`,
          userId: user._id,
          expiresAt: now + 60_000,
          createdAt: now,
          updatedAt: now,
          adminTwoFactorVerifiedAt: now,
        },
      },
    });
    return { userId: user._id, sessionId: session._id };
  });
  return {
    client: t.withIdentity({ subject: identity.userId, sessionId: identity.sessionId }),
    userId: identity.userId,
  };
}

const previousAdminPanelEnabled = process.env.ADMIN_PANEL_ENABLED;
const previousAdminEnvironment = process.env.ADMIN_ENVIRONMENT;

afterEach(() => {
  if (previousAdminPanelEnabled === undefined) delete process.env.ADMIN_PANEL_ENABLED;
  else process.env.ADMIN_PANEL_ENABLED = previousAdminPanelEnabled;
  if (previousAdminEnvironment === undefined) delete process.env.ADMIN_ENVIRONMENT;
  else process.env.ADMIN_ENVIRONMENT = previousAdminEnvironment;
});

function request(overrides: Record<string, unknown> = {}) {
  return {
    type: "ingest_remote",
    targetType: "documentVersion",
    targetId: "version_01",
    payload: {
      documents: [{ bucketId: 17, sourceUrl: "https://law.example/doc.pdf" }],
    },
    idempotencyKey: "publish-version-01",
    systemActor: "groundx_orchestrator",
    ...overrides,
  };
}

async function claimLease(t: Backend, jobId: Id<"integrationJobs">) {
  const claim = await t.mutation(claimJob, { jobId });
  if (!claim || typeof claim.leaseToken !== "string") {
    throw new Error("expected job lease");
  }
  return claim.leaseToken as string;
}

describe("durable GroundX jobs", () => {
  it("does not expose the generic provider dispatcher as a privileged public function", () => {
    expect(E2E_PRIVILEGED_FUNCTIONS.map((entry) => entry.path)).not.toContain("admin/jobs:enqueueJob");
  });
  it("claims and terminalizes a stubbed E2E job without constructing a provider transport", async () => {
    const t = convexTest(schema, modules);
    Object.assign(process.env, {
      ADMIN_E2E_FIXTURE_MODE: "true",
      ADMIN_E2E_TARGET_ENV: "test",
      ADMIN_E2E_ISOLATED_TARGET_MARKER: "isolated-admin-e2e",
      ADMIN_E2E_PROVIDER_STUB_MODE: "true",
    });
    delete process.env.GROUNDX_API_KEY;
    try {
      const created = await t.mutation(enqueueJob, request({
        type: "poll_process",
        targetType: "e2e_fixture",
        targetId: "e2e_stub_transport",
        payload: { processId: "never-sent-to-provider" },
        idempotencyKey: "e2e-stub-transport",
      }));
      await t.action(runGroundxJob, { jobId: created.jobId });
      await expect(t.run((ctx) => ctx.db.get(created.jobId))).resolves.toMatchObject({
        status: "succeeded",
        processId: expect.stringMatching(/^e2e_stub_/),
      });
    } finally {
      for (const key of ["ADMIN_E2E_FIXTURE_MODE", "ADMIN_E2E_TARGET_ENV", "ADMIN_E2E_ISOLATED_TARGET_MARKER", "ADMIN_E2E_PROVIDER_STUB_MODE"]) delete process.env[key];
    }
  });

  it("refuses a partially configured E2E job before provider construction", async () => {
    const t = convexTest(schema, modules);
    const created = await t.mutation(enqueueJob, request({
      type: "poll_process", targetType: "e2e_fixture", targetId: "e2e_partial_transport",
      payload: { processId: "never-sent-to-provider" }, idempotencyKey: "e2e-partial-transport",
    }));
    process.env.ADMIN_E2E_FIXTURE_MODE = "true";
    delete process.env.GROUNDX_API_KEY;
    try {
      await expect(t.action(runGroundxJob, { jobId: created.jobId })).rejects.toThrow("E2E_PROVIDER_ISOLATION_MISCONFIGURED");
    } finally {
      delete process.env.ADMIN_E2E_FIXTURE_MODE;
    }
  });

  it("collapses concurrent identical enqueue attempts into one job", async () => {
    const t = convexTest(schema, modules);
    const [first, second] = await Promise.all([
      t.mutation(enqueueJob, request()),
      t.mutation(enqueueJob, request()),
    ]);

    expect(second.jobId).toBe(first.jobId);
    expect(first.callbackToken).toBeNull();
    expect(second.callbackToken).toBeNull();
    expect(second.callbackTokenHash).toBe(first.callbackTokenHash);
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
      scheduled: await ctx.db.system.query("_scheduled_functions").take(4),
    }));
    const persisted = JSON.stringify(snapshot);
    expect(created.callbackToken).toBeNull();
    expect(persisted).not.toMatch(/gx_[a-f0-9]{64}/);
    expect(persisted).not.toContain("never-store-me");
    expect(snapshot.jobs[0]).toMatchObject({ actorId: "system", actorRoles: [] });
    expect(snapshot.audits).toHaveLength(1);
    expect(snapshot.audits[0].correlationId).toBe(snapshot.jobs[0].correlationId);
  });

  it("allows a token-bound fast callback to bind the provider process once", async () => {
    const t = convexTest(schema, modules);
    const created = await t.mutation(enqueueJob, request());

    await expect(
      t.mutation(applyProviderResult, {
        jobId: created.jobId,
        leaseToken: "lease_not_current",
        processId: "process-1",
        status: "processing",
      }),
    ).rejects.toThrow("INTEGRATION_LEASE_INVALID");
    await expect(
      t.mutation(recordProviderFailure, {
        jobId: created.jobId,
        leaseToken: "lease_not_current",
        kind: "network",
      }),
    ).rejects.toThrow("INTEGRATION_LEASE_INVALID");
    const leaseToken = await claimLease(t, created.jobId);
    const callbackTokenHash = "a".repeat(64);
    await t.mutation(armGroundxCallback, {
      jobId: created.jobId,
      leaseToken,
      tokenHash: callbackTokenHash,
    });
    const accepted = await t.mutation(completeGroundxCallback, {
      tokenHash: callbackTokenHash,
      processId: "process-1",
      status: "complete",
    });
    expect(accepted).toEqual({ accepted: true, duplicate: false });
    await expect(
      t.mutation(completeGroundxCallback, {
        tokenHash: callbackTokenHash,
        processId: "process-1",
        status: "complete",
      }),
    ).resolves.toEqual({ accepted: true, duplicate: true });
    await expect(
      t.mutation(applyProviderResult, {
        jobId: created.jobId,
        leaseToken,
        processId: "process-1",
        status: "complete",
      }),
    ).rejects.toThrow("INTEGRATION_LEASE_INVALID");
  });

  it("never automatically replays an ambiguous ingest transport failure", async () => {
    const t = convexTest(schema, modules);
    const created = await t.mutation(enqueueJob, request({ idempotencyKey: "uncertain-ingest-send" }));
    const leaseToken = await claimLease(t, created.jobId);

    await expect(t.mutation(recordProviderFailure, {
      jobId: created.jobId,
      leaseToken,
      kind: "network",
    })).resolves.toEqual({ status: "manual_review", nextAttemptAt: null });
    await expect(t.run((ctx) => ctx.db.get(created.jobId))).resolves.toMatchObject({
      status: "manual_review",
      attemptCount: 1,
      lastErrorKind: "network",
    });
  });

  it("retries transport and rate-limit failures at 1, 5, and 20 minutes then requires review", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T00:00:00Z"));
    try {
      const t = convexTest(schema, modules);
      const created = await t.mutation(enqueueJob, request());
      const delays = [60_000, 300_000, 1_200_000];
      for (let index = 0; index < delays.length; index += 1) {
        const leaseToken = await claimLease(t, created.jobId);
        const now = Date.now();
        const result = await t.mutation(recordProviderFailure, {
          jobId: created.jobId,
          leaseToken,
          kind: "rate_limit",
        });
        expect(result).toMatchObject({ status: "queued", nextAttemptAt: now + delays[index] });
        vi.setSystemTime(now + delays[index]);
      }
      const leaseToken = await claimLease(t, created.jobId);
      await expect(
        t.mutation(recordProviderFailure, {
          jobId: created.jobId,
          leaseToken,
          kind: "rate_limit",
        }),
      ).resolves.toMatchObject({ status: "manual_review", nextAttemptAt: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("explicitly reclaims transport-uncertain manual review work for a durable provider poll", async () => {
    const t = convexTest(schema, modules);
    const created = await t.mutation(enqueueJob, request({
      targetType: "operation",
      targetId: "uncertain-operation",
      idempotencyKey: "uncertain-operation",
    }));
    const initialLease = await claimLease(t, created.jobId);
    await t.mutation(applyProviderResult, {
      jobId: created.jobId,
      leaseToken: initialLease,
      processId: "uncertain-process",
      status: "processing",
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await t.run(async (ctx) => ctx.db.patch(created.jobId, { nextAttemptAt: Date.now() - 1 }));
      const leaseToken = await claimLease(t, created.jobId);
      await t.mutation(recordProviderFailure, {
        jobId: created.jobId,
        leaseToken,
        kind: "network",
      });
    }

    const reclaimed = await t.mutation(reconcileManualReviewJob, { jobId: created.jobId });
    expect(reclaimed).toMatchObject({
      workKind: "poll",
      leaseToken: expect.any(String),
      job: { status: "running", processId: "uncertain-process" },
    });
    await expect(t.mutation(applyProviderResult, {
      jobId: created.jobId,
      leaseToken: reclaimed?.leaseToken,
      processId: "uncertain-process",
      status: "complete",
    })).resolves.toEqual({ accepted: true, duplicate: false });
  });

  it("fails non-retryable provider errors without scheduling another attempt", async () => {
    const t = convexTest(schema, modules);
    const created = await t.mutation(enqueueJob, request());
    const leaseToken = await claimLease(t, created.jobId);
    await expect(
      t.mutation(recordProviderFailure, {
        jobId: created.jobId,
        leaseToken,
        kind: "validation",
      }),
    ).resolves.toEqual({ status: "failed", nextAttemptAt: null });
  });

  it("uses the typed adapter retryability decision for provider failures", async () => {
    const t = convexTest(schema, modules);
    const terminal = await t.mutation(
      enqueueJob,
      request({ targetId: "terminal-provider", idempotencyKey: "terminal-provider" }),
    );
    const leaseToken = await claimLease(t, terminal.jobId);
    await expect(
      t.mutation(recordProviderFailure, {
        jobId: terminal.jobId,
        leaseToken,
        kind: "provider",
        retryable: true,
      }),
    ).rejects.toThrow();
    await expect(
      t.mutation(recordProviderFailure, {
        jobId: terminal.jobId,
        leaseToken,
        kind: "provider",
      }),
    ).resolves.toEqual({ status: "failed", nextAttemptAt: null });
  });

  it("rejects callback token, process, target, and body mismatches and accepts replay", async () => {
    const t = convexTest(schema, modules);
    const created = await t.mutation(enqueueJob, request());
    const leaseToken = await claimLease(t, created.jobId);
    const callbackToken = `gx_${"c".repeat(64)}`;
    const callbackTokenHash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(callbackToken))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    await t.mutation(armGroundxCallback, {
      jobId: created.jobId,
      leaseToken,
      tokenHash: callbackTokenHash,
    });
    await t.mutation(applyProviderResult, {
      jobId: created.jobId,
      leaseToken,
      processId: "process-7",
      status: "processing",
    });

    expect(
      (await t.fetch("/groundx/callback", {
        method: "POST",
        body: JSON.stringify({ callbackData: `gx_${"d".repeat(64)}`, ingest: { processId: "process-7", status: "complete" } }),
      })).status,
    ).toBe(404);
    expect(
      (await t.fetch("/groundx/callback", {
        method: "POST",
        body: JSON.stringify({ callbackData: callbackToken, ingest: { processId: "other", status: "complete" } }),
      })).status,
    ).toBe(404);
    expect(
      (await t.fetch("/groundx/callback", {
        method: "POST",
        body: "x".repeat(16_385),
      })).status,
    ).toBe(400);
    expect(
      (await t.fetch("/groundx/callback", {
        method: "POST",
        body: "{",
      })).status,
    ).toBe(400);
    expect(
      (await t.fetch("/groundx/callback", {
        method: "POST",
        body: JSON.stringify({}),
      })).status,
    ).toBe(400);
    const body = JSON.stringify({
      callbackData: callbackToken,
      ingest: { processId: "process-7", status: "complete" },
      rawBody: "provider-sensitive-body",
    });
    expect((await t.fetch("/groundx/callback", { method: "POST", body })).status).toBe(202);
    expect((await t.fetch("/groundx/callback", { method: "POST", body })).status).toBe(202);
    const persisted = JSON.stringify(await t.run(async (ctx) => ({
      jobs: await ctx.db.query("integrationJobs").take(2),
      audits: await ctx.db.query("auditEvents").take(10),
    })));
    expect(persisted).not.toContain(callbackToken);
    expect(persisted).not.toContain("provider-sensitive-body");
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
      await expect(t.run(async (ctx) => ctx.db.get(running.jobId))).resolves.toMatchObject({
        status: "running",
        leaseToken: expect.any(String),
      });
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

  it("arms the callback hash before the claimed action calls the remote ingest adapter", async () => {
    const t = convexTest(schema, modules);
    const created = await t.mutation(enqueueJob, request({ idempotencyKey: "callback-order" }));
    const job = await t.run(async (ctx) => ctx.db.get(created.jobId as Id<"integrationJobs">));
    if (!job) throw new Error("missing fixture job");
    const order: string[] = [];
    const adapter = {
      createBucket: vi.fn(),
      ingestRemote: vi.fn(async () => {
        order.push("adapter");
        return { processId: "process-callback", status: "processing" as const };
      }),
      copyDocuments: vi.fn(),
      deleteDocuments: vi.fn(),
      getProcess: vi.fn(),
    };
    const arm = vi.fn(async ({ tokenHash }: { tokenHash: string }) => {
      expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
      order.push("arm");
    });

    await expect(executeClaimedGroundxJob({
      adapter,
      job: { ...job, status: "running" as const, leaseToken: "lease_callback" },
      leaseToken: "lease_callback",
      callbackSiteUrl: "https://law.example.convex.site/ignored/path",
      armCallback: arm,
      tokenFactory: () => `gx_${"b".repeat(64)}`,
    })).resolves.toEqual({ processId: "process-callback", status: "processing" });

    expect(order).toEqual(["arm", "adapter"]);
    expect(adapter.ingestRemote).toHaveBeenCalledWith({
      documents: [{ bucketId: 17, sourceUrl: "https://law.example/doc.pdf" }],
      callbackUrl: "https://law.example.convex.site/groundx/callback",
      callbackData: `gx_${"b".repeat(64)}`,
    });
    expect(JSON.stringify(arm.mock.calls)).not.toContain(`gx_${"b".repeat(64)}`);
  });

  it("does not expose the generic job dispatcher as a privileged public command", () => {
    expect(E2E_PRIVILEGED_FUNCTIONS.map((entry) => entry.path)).not.toContain(
      "admin/jobs:enqueueJob",
    );
  });

  it("rejects results from an expired lease after a newer worker reclaims the job", async () => {
    const t = convexTest(schema, modules);
    const created = await t.mutation(
      enqueueJob,
      request({ targetId: "lease-race", idempotencyKey: "lease-race-job" }),
    );
    const leaseA = await t.mutation(claimJob, { jobId: created.jobId });
    expect(leaseA).toMatchObject({ leaseToken: expect.any(String) });
    await t.run(async (ctx) => {
      await ctx.db.patch(created.jobId, { nextAttemptAt: Date.now() - 1 });
    });
    await t.mutation(reconcileStaleJobs, {});
    const current = await t.run(async (ctx) =>
      ctx.db.get(created.jobId as Id<"integrationJobs">),
    );
    expect(current?.leaseToken).not.toBe(leaseA.leaseToken);

    await expect(
      t.mutation(applyProviderResult, {
        jobId: created.jobId,
        leaseToken: leaseA.leaseToken,
        processId: "stale-process",
        status: "complete",
      }),
    ).rejects.toThrow("INTEGRATION_LEASE_INVALID");
    await expect(
      t.mutation(recordProviderFailure, {
        jobId: created.jobId,
        leaseToken: leaseA.leaseToken,
        kind: "network",
      }),
    ).rejects.toThrow("INTEGRATION_LEASE_INVALID");
    await expect(
      t.mutation(applyProviderResult, {
        jobId: created.jobId,
        leaseToken: current?.leaseToken,
        processId: "current-process",
        status: "complete",
      }),
    ).resolves.toEqual({ accepted: true, duplicate: false });
    const auditText = JSON.stringify(
      await t.run(async (ctx) => ctx.db.query("auditEvents").take(10)),
    );
    expect(auditText).not.toContain(leaseA.leaseToken);
    expect(auditText).not.toContain(current?.leaseToken);
  });

  it("fairly drains more than one mixed batch and schedules immediate continuation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T00:00:00Z"));
    try {
      const t = convexTest(schema, modules);
      const groupIds: Record<"queued" | "running" | "waiting_callback", Id<"integrationJobs">[]> = {
        queued: [],
        running: [],
        waiting_callback: [],
      };
      await t.run(async (ctx) => {
        for (let index = 0; index < 30; index += 1) {
          for (const status of ["queued", "running", "waiting_callback"] as const) {
            const id = await ctx.db.insert("integrationJobs", {
              type: "ingest_remote",
              targetType: "documentVersion",
              targetId: `${status}-${index}`,
              payload: "{}",
              actorId: "system",
              actorRoles: [],
              idempotencyKey: `${status}-job-${index}`,
              requestFingerprint: `${status}${String(index).padStart(58, "0")}`,
              correlationId: `${status}-${index}`,
              callbackTokenHash: `${index.toString(16).padStart(64, "0")}`,
              ...(status !== "queued" ? { processId: `${status}-process-${index}` } : {}),
              status,
              attemptCount: 0,
              nextAttemptAt: Date.now() - 1,
              createdAt: Date.now() + index,
              updatedAt: Date.now(),
            });
            groupIds[status].push(id);
          }
        }
      });

      expect(await t.mutation(reconcileStaleJobs, {})).toEqual({
        scheduled: 25,
        hasMore: true,
      });
      const afterFirst = await t.run(async (ctx) => ({
        groups: Object.fromEntries(
          await Promise.all(
            Object.entries(groupIds).map(async ([status, ids]) => [
              status,
              (await Promise.all(ids.map((id) => ctx.db.get(id)))).filter(
                (job) => job?.leaseToken !== undefined,
              ).length,
            ]),
          ),
        ),
        scheduled: await ctx.db.system.query("_scheduled_functions").take(100),
      }));
      expect(afterFirst.groups).toMatchObject({
        queued: expect.any(Number),
        running: expect.any(Number),
        waiting_callback: expect.any(Number),
      });
      expect(
        Object.values(afterFirst.groups as Record<string, number>).every(
          (count) => count > 0,
        ),
      ).toBe(true);
      expect(afterFirst.scheduled).toHaveLength(26);

      let result = { scheduled: 25, hasMore: true };
      for (let batch = 0; batch < 4 && result.hasMore; batch += 1) {
        result = await t.mutation(reconcileStaleJobs, {});
      }
      expect(result.hasMore).toBe(false);
      const due = await t.run(async (ctx) =>
        Promise.all(
          (["queued", "running", "waiting_callback"] as const).map((status) =>
            ctx.db
              .query("integrationJobs")
              .withIndex("by_status_and_nextAttemptAt", (q) =>
                q.eq("status", status).lte("nextAttemptAt", Date.now()),
              )
              .take(1),
          ),
        ),
      );
      expect(due.flat()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
