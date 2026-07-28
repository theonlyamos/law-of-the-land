import { makeFunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import { hashPassword } from "better-auth/crypto";
import { components } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalAction, internalMutation } from "../_generated/server";
import { hashCallbackToken } from "./jobs";
import { applyPublicationJobOutcome } from "./publicationState";

const FIXTURE_MARKER = "isolated-admin-e2e";
const TAG_RE = /^e2e_[a-z0-9]{12,48}$/;
const FIXED_ROLES = [
  "super_admin", "content_manager", "content_reviewer", "support_agent", "billing_manager", "auditor",
] as const;

function requireFixtureEnvironment() {
  if (
    process.env.ADMIN_E2E_FIXTURE_MODE !== "true" ||
    !["test", "preview"].includes(process.env.ADMIN_E2E_TARGET_ENV ?? "") ||
    process.env.ADMIN_E2E_ISOLATED_TARGET_MARKER !== FIXTURE_MARKER
  ) {
    throw new ConvexError("E2E_FIXTURES_DISABLED");
  }
}

async function sha256(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export async function authorizeFixtureRequest(request: Request) {
  try { requireFixtureEnvironment(); } catch { return false; }
  const configured = process.env.ADMIN_E2E_FIXTURE_SECRET;
  const header = request.headers.get("authorization") ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!configured || configured.length < 32 || supplied.length < 32) return false;
  const [left, right] = await Promise.all([sha256(configured), sha256(supplied)]);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function requireTag(tag: string) {
  if (!TAG_RE.test(tag)) throw new ConvexError("E2E_FIXTURE_TAG_INVALID");
}

async function listFixtureUsers(ctx: MutationCtx, tag: string) {
  const suffix = `.${tag}@e2e.invalid`;
  const matches: Array<{ userId: string; email: string }> = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const result = await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: "user",
      select: ["id", "email"],
      paginationOpts: { numItems: 100, cursor },
    }) as { page: Array<{ _id: string; email?: string }>; isDone: boolean; continueCursor: string };
    for (const user of result.page) {
      if (typeof user.email === "string" && user.email.endsWith(suffix)) matches.push({ userId: user._id, email: user.email });
    }
    if (result.isDone) break;
    cursor = result.continueCursor;
  }
  return matches;
}

async function cleanupFixture(ctx: MutationCtx, tag: string) {
  let deleted = 0;
  const fixtureUsers = await listFixtureUsers(ctx, tag);
  const fixtureUserIds = new Set(fixtureUsers.map((user) => user.userId));
  for (const user of fixtureUsers) {
    const paginationOpts = { numItems: 100, cursor: null, maximumRowsRead: 100 };
    await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
      input: { model: "session", where: [{ field: "userId", operator: "eq", value: user.userId }] }, paginationOpts,
    });
    await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
      input: { model: "account", where: [{ field: "userId", operator: "eq", value: user.userId }] }, paginationOpts,
    });
    await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
      input: { model: "twoFactor", where: [{ field: "userId", operator: "eq", value: user.userId }] }, paginationOpts,
    });
    await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
      input: { model: "user", where: [{ field: "_id", operator: "eq", value: user.userId }] }, paginationOpts,
    });
    deleted += 1;
  }

  const chat = await ctx.db.query("chatSessions")
    .withIndex("by_user_externalId", (q) => q.eq("userId", `fixture:${tag}`).eq("externalId", tag)).unique();
  if (chat) {
    for (const row of await ctx.db.query("messages").withIndex("by_session", (q) => q.eq("sessionId", chat._id)).take(200)) {
      await ctx.db.delete(row._id); deleted += 1;
    }
    for (const grant of await ctx.db.query("adminAccessGrants").withIndex("by_expiresAt").take(500)) {
      if (grant.chatSessionId === chat._id) { await ctx.db.delete(grant._id); deleted += 1; }
    }
    await ctx.db.delete(chat._id); deleted += 1;
  }

  const jurisdiction = await ctx.db.query("jurisdictions").withIndex("by_slug", (q) => q.eq("slug", tag)).unique();
  if (jurisdiction) {
    const resources = await ctx.db.query("legalResources")
      .withIndex("by_jurisdictionId_and_updatedAt", (q) => q.eq("jurisdictionId", jurisdiction._id)).take(20);
    for (const resource of resources) {
      if (resource.createdBy !== `fixture:${tag}`) continue;
      const versions = await ctx.db.query("documentVersions")
        .withIndex("by_resourceId_and_versionNumber", (q) => q.eq("resourceId", resource._id)).take(20);
      for (const version of versions) {
        for (const decision of await ctx.db.query("reviewDecisions").withIndex("by_documentVersionId_and_createdAt", (q) => q.eq("documentVersionId", version._id)).take(20)) {
          await ctx.db.delete(decision._id); deleted += 1;
        }
        await ctx.storage.delete(version.originalStorageId);
        await ctx.db.delete(version._id); deleted += 1;
      }
      for (const lock of await ctx.db.query("documentLifecycleLocks").withIndex("by_resourceId", (q) => q.eq("resourceId", resource._id)).take(20)) {
        await ctx.db.delete(lock._id); deleted += 1;
      }
      const counter = await ctx.db.query("resourceVersionCounters").withIndex("by_resourceId", (q) => q.eq("resourceId", resource._id)).unique();
      if (counter) { await ctx.db.delete(counter._id); deleted += 1; }
      await ctx.db.delete(resource._id); deleted += 1;
    }
    await ctx.db.delete(jurisdiction._id); deleted += 1;
  }

  for (const job of await ctx.db.query("integrationJobs")
    .withIndex("by_targetType_and_targetId", (q) => q.eq("targetType", "e2e_fixture").eq("targetId", tag)).take(100)) {
    await ctx.db.delete(job._id); deleted += 1;
  }
  for (const usage of await ctx.db.query("dailyUsage").withIndex("by_user_day", (q) => q.eq("userId", `fixture:${tag}`).eq("day", tag)).take(10)) {
    await ctx.db.delete(usage._id); deleted += 1;
  }
  for (const override of await ctx.db.query("quotaOverrides").withIndex("by_userId_and_startsAt", (q) => q.eq("userId", `fixture:${tag}`)).take(100)) {
    await ctx.db.delete(override._id); deleted += 1;
  }
  for (const operation of await ctx.db.query("adminOperations").withIndex("by_action_and_targetId_and_createdAt", (q) => q.eq("action", "e2e.fixture").eq("targetId", tag)).take(100)) {
    await ctx.db.delete(operation._id); deleted += 1;
  }
  for (const userId of fixtureUserIds) {
    for (const event of await ctx.db.query("auditEvents").withIndex("by_actorId_and_createdAt", (q) => q.eq("actorId", userId)).take(200)) {
      await ctx.db.delete(event._id); deleted += 1;
    }
  }
  return deleted;
}

const sessionManifestValidator = v.object({ userId: v.string(), sessionToken: v.string() });
const bootstrapResultValidator = v.object({
  tag: v.string(),
  sessions: v.object({
    super_admin: sessionManifestValidator,
    content_manager: sessionManifestValidator,
    content_reviewer: sessionManifestValidator,
    support_agent: sessionManifestValidator,
    billing_manager: sessionManifestValidator,
    auditor: sessionManifestValidator,
  }),
  variants: v.object({
    normal: sessionManifestValidator,
    noTwoFactor: sessionManifestValidator,
    unassured: sessionManifestValidator,
  }),
  records: v.object({
    chatId: v.id("chatSessions"), resourceId: v.id("legalResources"), publishedVersionId: v.id("documentVersions"),
    reviewVersionId: v.id("documentVersions"), conversationGrantId: v.id("adminAccessGrants"), jurisdictionId: v.id("jurisdictions"),
    separationVersionId: v.id("documentVersions"),
    userId: v.string(), stagingBucketId: v.string(), productionBucketId: v.string(),
    callbackToken: v.string(), callbackJobId: v.id("integrationJobs"), usageUserId: v.string(),
  }),
});

export const bootstrapRecords = internalMutation({
  args: { tag: v.string(), passwordHash: v.string(), publishedStorageId: v.id("_storage"), reviewStorageId: v.id("_storage"), separationStorageId: v.id("_storage") },
  returns: bootstrapResultValidator,
  handler: async (ctx, { tag, passwordHash, publishedStorageId, reviewStorageId, separationStorageId }) => {
    requireFixtureEnvironment(); requireTag(tag);
    const environment = process.env.ADMIN_E2E_TARGET_ENV!;
    const panel = await ctx.db.query("featureFlags")
      .withIndex("by_key_and_environment", (q) => q.eq("key", "admin_panel").eq("environment", environment)).unique();
    if (!panel?.enabled) throw new ConvexError("E2E_ADMIN_PANEL_FLAG_REQUIRED");
    await cleanupFixture(ctx, tag);

    const now = Date.now();
    const sessions = {} as Record<(typeof FIXED_ROLES)[number], { userId: string; sessionToken: string }>;
    const createUser = async (key: string, role: string, twoFactorEnabled: boolean, assured: boolean) => {
      const user = await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "user", data: {
        name: `${key} E2E fixture`, email: `${key}.${tag}@e2e.invalid`, emailVerified: true, createdAt: now, updatedAt: now,
        role, banned: false, twoFactorEnabled,
      } } });
      const token = `${tag}_${crypto.randomUUID().replaceAll("-", "")}`;
      await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "account", data: {
        accountId: user._id, providerId: "credential", userId: user._id, password: passwordHash, createdAt: now, updatedAt: now,
      } } });
      await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "session", data: {
        token, userId: user._id, expiresAt: now + 60 * 60_000, createdAt: now, updatedAt: now,
        ...(assured ? { adminTwoFactorVerifiedAt: now } : {}),
      } } });
      return { userId: user._id, sessionToken: token };
    };
    for (const role of FIXED_ROLES) sessions[role] = await createUser(role, role, true, true);
    const normal = await createUser("normal", "user", false, false);
    const noTwoFactor = await createUser("no_two_factor", "super_admin", false, false);
    const unassured = await createUser("unassured", "super_admin", true, false);

    const jurisdictionId = await ctx.db.insert("jurisdictions", {
      code: "ZZ", name: `${tag} jurisdiction`, slug: tag, status: "enabled", isDefault: false,
      stagingBucketId: `${tag}-staging`, productionBucketId: `${tag}-production`, providerSyncState: "synced",
      createdBy: `fixture:${tag}`, updatedBy: `fixture:${tag}`, createdAt: now, updatedAt: now,
    });
    const resourceId = await ctx.db.insert("legalResources", {
      jurisdictionId, type: "act", title: `${tag} Legal Resource`, issuer: "E2E fixture",
      officialCitation: tag, officialCitationKey: tag, sourceUrl: "https://example.invalid/e2e", topics: ["fixture"],
      effectiveDate: "2026-01-01", status: "active", createdBy: `fixture:${tag}`, updatedBy: `fixture:${tag}`,
      createdAt: now, updatedAt: now,
    });
    const publishedVersionId = await ctx.db.insert("documentVersions", {
      resourceId, versionNumber: 1, originalStorageId: publishedStorageId, filename: `${tag}-published.pdf`, mimeType: "application/pdf",
      byteSize: 17, sha256: "a".repeat(64), sourceUrl: "https://example.invalid/e2e-v1", effectiveDate: "2026-01-01",
      status: "published", groundxStagingDocumentId: `${tag}-stage-doc-1`, groundxProductionDocumentId: `${tag}-prod-doc-1`,
      submittedBy: sessions.content_manager.userId, reviewedBy: sessions.content_reviewer.userId,
      submittedAt: now, reviewedAt: now, publishedAt: now, createdAt: now, updatedAt: now,
    });
    const reviewVersionId = await ctx.db.insert("documentVersions", {
      resourceId, versionNumber: 2, originalStorageId: reviewStorageId, filename: `${tag}-review.pdf`, mimeType: "application/pdf",
      byteSize: 14, sha256: "b".repeat(64), sourceUrl: "https://example.invalid/e2e-v2", effectiveDate: "2026-02-01",
      status: "ready_for_review", groundxStagingDocumentId: `${tag}-stage-doc-2`, submittedBy: sessions.content_manager.userId,
      submittedAt: now, createdAt: now + 1, updatedAt: now + 1,
    });
    const separationVersionId = await ctx.db.insert("documentVersions", {
      resourceId, versionNumber: 3, originalStorageId: separationStorageId, filename: `${tag}-reviewer-submitted.pdf`, mimeType: "application/pdf",
      byteSize: 18, sha256: "c".repeat(64), sourceUrl: "https://example.invalid/e2e-v3", effectiveDate: "2026-03-01",
      status: "ready_for_review", groundxStagingDocumentId: `${tag}-stage-doc-3`, submittedBy: sessions.content_reviewer.userId,
      submittedAt: now, createdAt: now + 2, updatedAt: now + 2,
    });
    await ctx.db.patch(resourceId, { activeVersionId: publishedVersionId });

    const chatId = await ctx.db.insert("chatSessions", {
      userId: `fixture:${tag}`, externalId: tag, title: `${tag} private conversation`, lastMessage: "fixture preview",
      messageCount: 2, updatedAt: now, country: "ZZ",
    });
    await ctx.db.insert("messages", { sessionId: chatId, role: "user", content: "Fixture private question", createdAt: now });
    await ctx.db.insert("messages", { sessionId: chatId, role: "assistant", content: "Fixture private answer", createdAt: now + 1 });
    const conversationGrantId = await ctx.db.insert("adminAccessGrants", {
      adminId: sessions.support_agent.userId, chatSessionId: chatId, purpose: "Fixture support investigation",
      issuedAt: now, expiresAt: now + 15 * 60_000, correlationId: `${tag}-grant`,
    });
    await ctx.db.insert("dailyUsage", { userId: `fixture:${tag}`, day: tag, count: 3 });

    const callbackToken = `gx_${Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const callbackJobId = await ctx.db.insert("integrationJobs", {
      type: "poll_process", targetType: "e2e_fixture", targetId: tag, payload: "{}", actorId: "system", actorRoles: [],
      idempotencyKey: `${tag}-callback`, requestFingerprint: "{}", correlationId: `${tag}-callback`,
      callbackTokenHash: await hashCallbackToken(callbackToken), processId: `${tag}-process`, status: "waiting_callback",
      attemptCount: 1, createdAt: now - 100 * 24 * 60 * 60_000, updatedAt: now,
    });

    return {
      tag, sessions,
      variants: { normal, noTwoFactor, unassured },
      records: {
        chatId, resourceId, publishedVersionId, reviewVersionId, separationVersionId, conversationGrantId, jurisdictionId, userId: normal.userId,
        stagingBucketId: `${tag}-staging`, productionBucketId: `${tag}-production`, callbackToken, callbackJobId,
        usageUserId: `fixture:${tag}`,
      },
    };
  },
});

const bootstrapRecordsRef = makeFunctionReference<"mutation">("admin/e2eFixtures:bootstrapRecords");

export const bootstrap = internalAction({
  args: { tag: v.string() },
  returns: bootstrapResultValidator,
  handler: async (ctx, { tag }) => {
    requireFixtureEnvironment(); requireTag(tag);
    const password = process.env.ADMIN_E2E_ACCOUNT_PASSWORD;
    if (!password || password.length < 12) throw new ConvexError("E2E_FIXTURE_PASSWORD_REQUIRED");
    const passwordHash = await hashPassword(password);
    const publishedStorageId = await ctx.storage.store(new Blob(["published fixture"], { type: "application/pdf" }));
    const reviewStorageId = await ctx.storage.store(new Blob(["review fixture"], { type: "application/pdf" }));
    const separationStorageId = await ctx.storage.store(new Blob(["separation fixture"], { type: "application/pdf" }));
    try {
      return await ctx.runMutation(bootstrapRecordsRef, { tag, passwordHash, publishedStorageId, reviewStorageId, separationStorageId }) as {
        tag: string;
        sessions: Record<(typeof FIXED_ROLES)[number], { userId: string; sessionToken: string }>;
        variants: Record<"normal" | "noTwoFactor" | "unassured", { userId: string; sessionToken: string }>;
        records: {
          chatId: Id<"chatSessions">; resourceId: Id<"legalResources">; publishedVersionId: Id<"documentVersions">;
          reviewVersionId: Id<"documentVersions">; separationVersionId: Id<"documentVersions">; conversationGrantId: Id<"adminAccessGrants">; jurisdictionId: Id<"jurisdictions">;
          userId: string; stagingBucketId: string; productionBucketId: string;
          callbackToken: string; callbackJobId: Id<"integrationJobs">; usageUserId: string;
        };
      };
    } catch (error) {
      await ctx.storage.delete(publishedStorageId);
      await ctx.storage.delete(reviewStorageId);
      await ctx.storage.delete(separationStorageId);
      throw error;
    }
  },
});

export const cleanup = internalMutation({
  args: { tag: v.string() },
  returns: v.object({ tag: v.string(), deleted: v.number() }),
  handler: async (ctx, { tag }) => {
    requireFixtureEnvironment(); requireTag(tag);
    return { tag, deleted: await cleanupFixture(ctx, tag) };
  },
});

const controlOperationValidator = v.union(
  v.literal("publication_failed"),
  v.literal("publication_succeeded"),
  v.literal("expire_conversation_grant"),
  v.literal("read_state"),
);

export const applyControl = internalMutation({
  args: { tag: v.string(), operation: controlOperationValidator, versionId: v.optional(v.id("documentVersions")) },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireFixtureEnvironment(); requireTag(args.tag);
    const jurisdiction = await ctx.db.query("jurisdictions").withIndex("by_slug", (q) => q.eq("slug", args.tag)).unique();
    if (!jurisdiction) throw new ConvexError("E2E_FIXTURE_NOT_FOUND");
    const resources = await ctx.db.query("legalResources")
      .withIndex("by_jurisdictionId_and_updatedAt", (q) => q.eq("jurisdictionId", jurisdiction._id)).take(10);
    const resource = resources.find((row) => row.createdBy === `fixture:${args.tag}`);
    if (!resource) throw new ConvexError("E2E_FIXTURE_NOT_FOUND");

    if (args.operation === "expire_conversation_grant") {
      const chat = await ctx.db.query("chatSessions")
        .withIndex("by_user_externalId", (q) => q.eq("userId", `fixture:${args.tag}`).eq("externalId", args.tag)).unique();
      if (!chat) throw new ConvexError("E2E_FIXTURE_NOT_FOUND");
      const fixtureUserIds = new Set((await listFixtureUsers(ctx, args.tag)).map((row) => row.userId));
      const grants = await ctx.db.query("adminAccessGrants").withIndex("by_expiresAt").take(500);
      const matching = grants.filter((row) => row.chatSessionId === chat._id && fixtureUserIds.has(row.adminId));
      if (matching.length === 0) throw new ConvexError("E2E_FIXTURE_GRANT_NOT_FOUND");
      for (const grant of matching) await ctx.db.patch(grant._id, { expiresAt: Date.now() - 1 });
    } else if (args.operation !== "read_state") {
      if (!args.versionId) throw new ConvexError("E2E_FIXTURE_VERSION_REQUIRED");
      const version = await ctx.db.get(args.versionId);
      if (!version || version.resourceId !== resource._id) throw new ConvexError("E2E_FIXTURE_VERSION_MISMATCH");
      const jobs = await ctx.db.query("integrationJobs")
        .withIndex("by_targetType_and_targetId", (q) => q.eq("targetType", "documentVersion").eq("targetId", version._id)).take(20);
      const job = jobs.sort((a, b) => b.createdAt - a.createdAt)[0];
      if (!job) throw new ConvexError("E2E_FIXTURE_JOB_NOT_FOUND");
      const outcome = args.operation === "publication_succeeded" ? "succeeded" : "failed";
      if (job.status !== outcome) {
        if (!["queued", "running", "manual_review", "waiting_callback"].includes(job.status)) {
          throw new ConvexError("E2E_FIXTURE_JOB_STATE_INVALID");
        }
        const processId = `${args.tag}-${args.operation}-${job._id}`;
        await ctx.db.patch(job._id, {
          status: outcome,
          processId,
          leaseToken: undefined,
          leaseExpiresAt: undefined,
          nextAttemptAt: undefined,
          retentionPending: true,
          updatedAt: Date.now(),
        });
        await applyPublicationJobOutcome(ctx, job, outcome, processId);
      }
    }

    const versions = await ctx.db.query("documentVersions")
      .withIndex("by_resourceId_and_versionNumber", (q) => q.eq("resourceId", resource._id)).take(10);
    const chat = await ctx.db.query("chatSessions")
      .withIndex("by_user_externalId", (q) => q.eq("userId", `fixture:${args.tag}`).eq("externalId", args.tag)).unique();
    const grants = chat ? await ctx.db.query("adminAccessGrants").withIndex("by_expiresAt").take(500) : [];
    const retention = await ctx.db.query("retentionState").withIndex("by_key", (q) => q.eq("key", "default")).unique();
    const callbackJob = await ctx.db.query("integrationJobs")
      .withIndex("by_targetType_and_targetId", (q) => q.eq("targetType", "e2e_fixture").eq("targetId", args.tag)).unique();
    return {
      activeVersionId: resource.activeVersionId ?? null,
      versions: versions.map((row) => ({ id: row._id, versionNumber: row.versionNumber, status: row.status, failureSummary: row.failureSummary ?? null })),
      grantActive: grants.some((row) => row.chatSessionId === chat?._id && row.correlationId === `${args.tag}-grant` && row.expiresAt > Date.now() && row.revokedAt === undefined),
      retention: { deletedTotal: retention?.deletedTotal ?? 0, lastSuccessfulAt: retention?.lastSuccessfulAt ?? null },
      callbackJob: callbackJob ? { status: callbackJob.status, payload: callbackJob.payload, retentionRedactedAt: callbackJob.retentionRedactedAt ?? null } : null,
    };
  },
});

const applyControlRef = makeFunctionReference<"mutation">("admin/e2eFixtures:applyControl");
const runRetentionBatchRef = makeFunctionReference<"mutation">("admin/operations:runRetentionBatch");

export const control = internalAction({
  args: {
    tag: v.string(),
    operation: v.union(controlOperationValidator, v.literal("run_retention")),
    versionId: v.optional(v.id("documentVersions")),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireFixtureEnvironment(); requireTag(args.tag);
    if (args.operation === "run_retention") {
      await ctx.runMutation(runRetentionBatchRef, { cursor: null });
      return await ctx.runMutation(applyControlRef, { tag: args.tag, operation: "read_state" });
    }
    return await ctx.runMutation(applyControlRef, args);
  },
});
