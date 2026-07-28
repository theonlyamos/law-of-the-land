import { makeFunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import { hashPassword } from "better-auth/crypto";
import { components } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalAction, internalMutation } from "../_generated/server";
import { hashCallbackToken } from "./jobs";
import { applyPublicationJobOutcome } from "./publicationState";
import { resolveE2EProviderIsolation } from "./e2eProviderIsolation";
import { E2E_PRIVILEGED_FUNCTIONS } from "./e2eAccessMatrix";

const FIXTURE_MARKER = "isolated-admin-e2e";
const TAG_RE = /^e2e_[a-z0-9]{12,48}$/;
const FIXED_ROLES = [
  "super_admin", "content_manager", "content_reviewer", "support_agent", "billing_manager", "auditor",
] as const;
// These are intentionally numeric because production publication validates
// GroundX bucket identifiers before it queues work. They are only fixture
// payload values; no provider call is made by this control plane.
const FIXTURE_STAGING_BUCKET_ID = "910001";
const FIXTURE_PRODUCTION_BUCKET_ID = "910002";

function requireFixtureEnvironment() {
  if (resolveE2EProviderIsolation() !== "stub") {
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
  const fixtureVersionIds = new Set<string>();
  const fixtureOperationIds = new Set<string>();
  const fixtureStorageIds = new Set<Id<"_storage">>();
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

  const fixtureChats = (await ctx.db.query("chatSessions").take(500)).filter((row) => row.userId === `fixture:${tag}`);
  const fixtureChatIds = new Set(fixtureChats.map((row) => row._id));
  for (const chat of fixtureChats) {
    for (const row of await ctx.db.query("messages").withIndex("by_session", (q) => q.eq("sessionId", chat._id)).take(200)) {
      await ctx.db.delete(row._id); deleted += 1;
    }
    for (const grant of await ctx.db.query("adminAccessGrants").withIndex("by_expiresAt").take(500)) {
      if (grant.chatSessionId === chat._id) { await ctx.db.delete(grant._id); deleted += 1; }
    }
    await ctx.db.delete(chat._id); deleted += 1;
  }

  const fixtureJurisdictions = (await ctx.db.query("jurisdictions").take(500)).filter(
    (row) => row.slug === tag || row.createdBy === `fixture:${tag}`,
  );
  for (const jurisdiction of fixtureJurisdictions) {
    const resources = await ctx.db.query("legalResources")
      .withIndex("by_jurisdictionId_and_updatedAt", (q) => q.eq("jurisdictionId", jurisdiction._id)).take(500);
    for (const resource of resources) {
      // The browser matrix invokes the production createResource mutation as
      // an assured fixture actor, so its createdBy is that actor rather than
      // the bootstrap sentinel. The tagged jurisdiction is the exact owner.
      const versions = await ctx.db.query("documentVersions")
        .withIndex("by_resourceId_and_versionNumber", (q) => q.eq("resourceId", resource._id)).take(20);
      for (const version of versions) {
        fixtureVersionIds.add(version._id);
        for (const decision of await ctx.db.query("reviewDecisions").withIndex("by_documentVersionId_and_createdAt", (q) => q.eq("documentVersionId", version._id)).take(20)) {
          await ctx.db.delete(decision._id); deleted += 1;
        }
        fixtureStorageIds.add(version.originalStorageId);
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

  // UI mutations use fixture actors and/or tagged target records, rather than
  // a separate table. Restrict cleanup to those exact identities and IDs.
  for (const incident of await ctx.db.query("systemIncidents").take(500)) {
    if (!incident.title.startsWith(tag) && !fixtureUserIds.has(incident.createdBy)) continue;
    for (const row of await ctx.db.query("incidentTimeline").withIndex("by_incidentId_and_createdAt", (q) => q.eq("incidentId", incident._id)).take(500)) {
      await ctx.db.delete(row._id); deleted += 1;
    }
    await ctx.db.delete(incident._id); deleted += 1;
  }
  for (const row of await ctx.db.query("adminOperations").take(500)) {
    if (!fixtureUserIds.has(row.actorId) && !row.targetId.startsWith(tag) && !fixtureVersionIds.has(row.targetId)) continue;
    fixtureOperationIds.add(row._id);
    await ctx.db.delete(row._id); deleted += 1;
  }
  for (const row of await ctx.db.query("adminStepUpProofs").take(500)) {
    if (fixtureUserIds.has(row.actorId) || fixtureVersionIds.has(row.targetId)) { await ctx.db.delete(row._id); deleted += 1; }
  }
  for (const row of await ctx.db.query("userDeletionRequests").take(500)) {
    if (fixtureOperationIds.has(row.operationId) || fixtureUserIds.has(row.actorId) || fixtureUserIds.has(row.targetUserId)) { await ctx.db.delete(row._id); deleted += 1; }
  }
  for (const row of await ctx.db.query("verificationEmailRequests").take(500)) {
    if (fixtureOperationIds.has(row.operationId) || fixtureUserIds.has(row.actorId) || fixtureUserIds.has(row.targetUserId)) { await ctx.db.delete(row._id); deleted += 1; }
  }
  const fixtureExports = (await ctx.db.query("adminExports").take(500)).filter((row) => fixtureUserIds.has(row.requesterId) || fixtureChatIds.has(row.chatSessionId));
  const fixtureExportIds = new Set(fixtureExports.map((row) => row._id));
  for (const row of await ctx.db.query("exportDownloadReferences").take(500)) {
    if (fixtureExportIds.has(row.exportId)) { await ctx.db.delete(row._id); deleted += 1; }
  }
  for (const row of fixtureExports) {
    if (row.storageId) fixtureStorageIds.add(row.storageId);
    await ctx.db.delete(row._id); deleted += 1;
  }

  for (const job of await ctx.db.query("integrationJobs").take(500)) {
    const taggedJob = job.targetType === "e2e_fixture" && (job.targetId === tag || job.targetId.startsWith(`${tag}-`) || job.targetId.startsWith(`${tag}:`));
    if (!taggedJob && job.targetId !== tag && !fixtureVersionIds.has(job.targetId) && !fixtureUserIds.has(job.actorId)) continue;
    await ctx.db.delete(job._id); deleted += 1;
  }
  for (const usage of await ctx.db.query("dailyUsage").withIndex("by_user_day", (q) => q.eq("userId", `fixture:${tag}`).eq("day", tag)).take(10)) {
    await ctx.db.delete(usage._id); deleted += 1;
  }
  for (const override of await ctx.db.query("quotaOverrides").take(500)) {
    if (override.userId !== `fixture:${tag}` && !override.userId.startsWith(`fixture:${tag}:`)) continue;
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
  for (const storageId of fixtureStorageIds) {
    if (await ctx.db.system.get("_storage", storageId)) await ctx.storage.delete(storageId);
  }
  return deleted;
}

const sessionManifestValidator = v.object({ userId: v.string(), sessionToken: v.string() });
const bootstrapResultValidator = v.object({
  tag: v.string(),
  providerTransport: v.literal("stub"),
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
      stagingBucketId: FIXTURE_STAGING_BUCKET_ID, productionBucketId: FIXTURE_PRODUCTION_BUCKET_ID, providerSyncState: "synced",
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
      tag, providerTransport: "stub" as const, sessions,
      variants: { normal, noTwoFactor, unassured },
      records: {
        chatId, resourceId, publishedVersionId, reviewVersionId, separationVersionId, conversationGrantId, jurisdictionId, userId: normal.userId,
        stagingBucketId: FIXTURE_STAGING_BUCKET_ID, productionBucketId: FIXTURE_PRODUCTION_BUCKET_ID, callbackToken, callbackJobId,
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
        providerTransport: "stub";
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

const matrixRoleValidator = v.union(...FIXED_ROLES.map((role) => v.literal(role)));
const MATRIX_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

async function fixtureActor(ctx: MutationCtx, tag: string, role: (typeof FIXED_ROLES)[number]) {
  const email = `${role}.${tag}@e2e.invalid`;
  const actor = (await listFixtureUsers(ctx, tag)).find((row) => row.email === email);
  if (!actor) throw new ConvexError("E2E_FIXTURE_ACTOR_NOT_FOUND");
  const sessions = await ctx.runQuery(components.betterAuth.adapter.findMany, {
    model: "session",
    where: [{ field: "userId", operator: "eq", value: actor.userId }],
    select: ["id", "userId", "expiresAt", "adminTwoFactorVerifiedAt"],
    paginationOpts: { numItems: 10, cursor: null },
  }) as { page: Array<{ _id: string; userId: string }>; isDone: boolean; continueCursor: string };
  if (sessions.page.length !== 1) throw new ConvexError("E2E_FIXTURE_SESSION_NOT_FOUND");
  return { userId: actor.userId, sessionId: sessions.page[0]._id };
}

async function createMatrixUser(
  ctx: MutationCtx,
  tag: string,
  key: string,
  kind: string,
  options: { emailVerified?: boolean; banned?: boolean; twoFactorEnabled?: boolean; session?: boolean } = {},
) {
  const now = Date.now();
  const user = await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "user", data: {
    name: `${kind} ${tag}`,
    email: `${kind}.${key}.${tag}@e2e.invalid`,
    emailVerified: options.emailVerified ?? true,
    createdAt: now,
    updatedAt: now,
    role: "user",
    banned: options.banned ?? false,
    twoFactorEnabled: options.twoFactorEnabled ?? false,
  } } });
  let sessionId: string | undefined;
  if (options.session) {
    const session = await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "session", data: {
      token: `${tag}_${key}_${kind}`,
      userId: user._id,
      expiresAt: now + 60 * 60_000,
      createdAt: now,
      updatedAt: now,
    } } });
    sessionId = session._id;
  }
  return { userId: user._id, sessionId };
}

async function mainFixtureRecords(ctx: MutationCtx, tag: string) {
  const jurisdiction = await ctx.db.query("jurisdictions").withIndex("by_slug", (q) => q.eq("slug", tag)).unique();
  if (!jurisdiction) throw new ConvexError("E2E_FIXTURE_NOT_FOUND");
  const resources = await ctx.db.query("legalResources").withIndex("by_jurisdictionId_and_updatedAt", (q) => q.eq("jurisdictionId", jurisdiction._id)).take(500);
  const resource = resources.find((row) => row.createdBy === `fixture:${tag}`);
  if (!resource) throw new ConvexError("E2E_FIXTURE_NOT_FOUND");
  const versions = await ctx.db.query("documentVersions").withIndex("by_resourceId_and_versionNumber", (q) => q.eq("resourceId", resource._id)).take(20);
  const storageId = versions.find((row) => row.versionNumber === 3)?.originalStorageId;
  if (!storageId) throw new ConvexError("E2E_FIXTURE_NOT_FOUND");
  const metadata = await ctx.db.system.get("_storage", storageId);
  if (!metadata) throw new ConvexError("E2E_FIXTURE_NOT_FOUND");
  const sha256Hex = /^[a-f0-9]{64}$/i.test(metadata.sha256)
    ? metadata.sha256.toLowerCase()
    : Array.from(Uint8Array.from(atob(metadata.sha256), (character) => character.charCodeAt(0)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { jurisdiction, resource, storageId, byteSize: metadata.size, sha256Hex };
}

async function createMatrixResource(ctx: MutationCtx, tag: string, key: string, suffix: string) {
  const { jurisdiction } = await mainFixtureRecords(ctx, tag);
  const now = Date.now();
  const citation = `${tag}-${key}-${suffix}`;
  const resourceId = await ctx.db.insert("legalResources", {
    jurisdictionId: jurisdiction._id,
    type: "act",
    title: `${tag} ${suffix} resource`,
    issuer: "E2E fixture",
    officialCitation: citation,
    officialCitationKey: citation.toLowerCase(),
    sourceUrl: "https://example.invalid/matrix",
    topics: ["fixture"],
    effectiveDate: "2026-01-01",
    status: "active",
    createdBy: `fixture:${tag}`,
    updatedBy: `fixture:${tag}`,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.insert("resourceVersionCounters", { resourceId, nextVersionNumber: 1, updatedAt: now });
  return resourceId;
}

async function createMatrixVersion(
  ctx: MutationCtx,
  tag: string,
  key: string,
  suffix: string,
  status: "draft" | "ready_for_review" | "approved" | "published" | "superseded",
  submittedBy: string,
) {
  const { storageId } = await mainFixtureRecords(ctx, tag);
  const resourceId = await createMatrixResource(ctx, tag, key, suffix);
  const now = Date.now();
  const versionId = await ctx.db.insert("documentVersions", {
    resourceId,
    versionNumber: 1,
    originalStorageId: storageId,
    filename: `${tag}-${suffix}.pdf`,
    mimeType: "application/pdf",
    byteSize: 18,
    sha256: `${suffix.charCodeAt(0).toString(16).padStart(2, "0")}`.repeat(32),
    sourceUrl: "https://example.invalid/matrix.pdf",
    effectiveDate: "2026-02-01",
    status,
    groundxStagingDocumentId: `${tag}-${key}-${suffix}-stage`,
    ...(status === "published" || status === "superseded" ? { groundxProductionDocumentId: `${tag}-${key}-${suffix}-prod` } : {}),
    submittedBy,
    ...(status === "ready_for_review" || status === "approved" || status === "published" || status === "superseded" ? { submittedAt: now } : {}),
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.patch(resourceId, { ...(status === "published" ? { activeVersionId: versionId } : {}), updatedAt: now });
  return { resourceId, versionId };
}

async function insertStepUp(ctx: MutationCtx, actor: { userId: string; sessionId: string }, action: string, targetId: string, key: string) {
  const now = Date.now();
  await ctx.db.insert("adminStepUpProofs", {
    actorId: actor.userId,
    sessionId: actor.sessionId,
    action,
    targetId,
    idempotencyKey: key,
    issuedAt: now,
    expiresAt: now + 5 * 60_000,
  });
}

async function prepareMatrixOperation(ctx: MutationCtx, input: { tag: string; path: string; role: (typeof FIXED_ROLES)[number]; key: string }) {
  if (!MATRIX_KEY_RE.test(input.key)) throw new ConvexError("E2E_MATRIX_KEY_INVALID");
  const entry = E2E_PRIVILEGED_FUNCTIONS.find((row) => row.path === input.path);
  if (!entry) throw new ConvexError("E2E_MATRIX_OPERATION_INVALID");
  const actor = await fixtureActor(ctx, input.tag, input.role);
  const reason = "Exercise isolated privileged operation";
  const marker = `${input.tag}-${input.key}`;
  const args: Record<string, unknown> = {};
  const user = async (kind: string, options: Parameters<typeof createMatrixUser>[4] = {}) => await createMatrixUser(ctx, input.tag, input.key, kind, options);
  const chatAndGrant = async () => {
    const chatId = await ctx.db.insert("chatSessions", { userId: `fixture:${input.tag}`, externalId: `${input.tag}:${input.key}`, title: `${marker} conversation`, lastMessage: "fixture", messageCount: 0, updatedAt: Date.now() });
    const grantId = await ctx.db.insert("adminAccessGrants", { adminId: actor.userId, chatSessionId: chatId, purpose: reason, issuedAt: Date.now(), expiresAt: Date.now() + 15 * 60_000, correlationId: `${marker}-grant` });
    return { chatId, grantId };
  };

  switch (input.path) {
    case "admin/roles:setAdminRoles": { const target = await user("setroles", { twoFactorEnabled: true }); Object.assign(args, { targetUserId: target.userId, roles: ["content_manager"] }); break; }
    case "admin/users:assignRoles": { const target = await user("assignroles", { twoFactorEnabled: true }); await insertStepUp(ctx, actor, "roles_assign", target.userId, input.key); Object.assign(args, { userId: target.userId, roles: ["content_manager"], reason, idempotencyKey: input.key }); break; }
    case "admin/users:banUser": { const target = await user("ban"); Object.assign(args, { userId: target.userId, reason, confirmation: `BAN ${target.userId}`, idempotencyKey: input.key }); break; }
    case "admin/users:unbanUser": { const target = await user("unban", { banned: true }); Object.assign(args, { userId: target.userId, reason, idempotencyKey: input.key }); break; }
    case "admin/users:resendVerification": { const target = await user("verify", { emailVerified: false }); Object.assign(args, { userId: target.userId, reason, idempotencyKey: input.key }); break; }
    case "admin/users:revokeSession": { const target = await user("revokesession", { session: true }); Object.assign(args, { userId: target.userId, sessionId: target.sessionId, reason, confirmation: `REVOKE ${target.sessionId}`, idempotencyKey: input.key }); break; }
    case "admin/users:revokeAllSessions": { const target = await user("revokeall", { session: true }); Object.assign(args, { userId: target.userId, reason, confirmation: `REVOKE ALL ${target.userId}`, idempotencyKey: input.key }); break; }
    case "admin/users:startImpersonation": { const target = await user("impersonate"); await insertStepUp(ctx, actor, "impersonation_start", target.userId, input.key); Object.assign(args, { userId: target.userId, reason, idempotencyKey: input.key }); break; }
    case "admin/users:queueUserDeletion": { const target = await user("delete"); await insertStepUp(ctx, actor, "user_deletion_queue", target.userId, input.key); Object.assign(args, { userId: target.userId, reason, confirmation: `DELETE ${target.userId}`, idempotencyKey: input.key }); break; }
    case "admin/conversations:createAccessGrant": { const chatId = await ctx.db.insert("chatSessions", { userId: `fixture:${input.tag}`, externalId: `${input.tag}:${input.key}`, title: `${marker} conversation`, lastMessage: "fixture", messageCount: 0, updatedAt: Date.now() }); Object.assign(args, { chatId, purpose: reason }); break; }
    case "admin/exports:queueConversationExport": { const { chatId, grantId } = await chatAndGrant(); await insertStepUp(ctx, actor, "conversation_export", `${chatId}:${grantId}`, input.key); Object.assign(args, { chatId, grantId, reason, confirmation: `EXPORT ${chatId}`, idempotencyKey: input.key }); break; }
    case "admin/exports:issueConversationExportReference": { const { chatId, grantId } = await chatAndGrant(); const { storageId } = await mainFixtureRecords(ctx, input.tag); const correlationId = `${marker}-export`; await ctx.db.insert("adminExports", { correlationId, requesterId: actor.userId, requesterSessionId: actor.sessionId, chatSessionId: chatId, accessGrantId: grantId, status: "ready", storageId, expiresAt: Date.now() + 10 * 60_000, createdAt: Date.now(), updatedAt: Date.now() }); Object.assign(args, { correlationId, grantId }); break; }
    case "admin/documents:generateUploadUrl": break;
    case "admin/documents:createDocumentVersion": { const resourceId = await createMatrixResource(ctx, input.tag, input.key, "create-version"); const stored = await mainFixtureRecords(ctx, input.tag); Object.assign(args, { resourceId, storageId: stored.storageId, filename: `${marker}.pdf`, mimeType: "application/pdf", byteSize: stored.byteSize, sha256: stored.sha256Hex, sourceUrl: "https://example.invalid/matrix", effectiveAt: "2026-02-01" }); break; }
    case "admin/resources:createJurisdiction": Object.assign(args, { code: `M${crypto.randomUUID().slice(0, 8).toUpperCase()}`, name: `${marker} jurisdiction`, slug: `m-${crypto.randomUUID().slice(0, 12)}`, stagingBucketId: FIXTURE_STAGING_BUCKET_ID, productionBucketId: FIXTURE_PRODUCTION_BUCKET_ID, isDefault: false, reason }); break;
    case "admin/resources:updateJurisdiction":
    case "admin/resources:enableJurisdiction":
    case "admin/resources:archiveJurisdiction": { const now = Date.now(); const id = await ctx.db.insert("jurisdictions", { code: `M${crypto.randomUUID().slice(0, 8).toUpperCase()}`, name: `${marker} jurisdiction`, slug: `m-${crypto.randomUUID().slice(0, 12)}`, status: input.path.endsWith("enableJurisdiction") ? "draft" : "enabled", isDefault: false, stagingBucketId: FIXTURE_STAGING_BUCKET_ID, productionBucketId: FIXTURE_PRODUCTION_BUCKET_ID, providerSyncState: "synced", createdBy: `fixture:${input.tag}`, updatedBy: `fixture:${input.tag}`, createdAt: now, updatedAt: now }); Object.assign(args, input.path.endsWith("updateJurisdiction") ? { id, name: `${marker} updated`, slug: `u-${crypto.randomUUID().slice(0, 12)}`, stagingBucketId: FIXTURE_STAGING_BUCKET_ID, productionBucketId: FIXTURE_PRODUCTION_BUCKET_ID, isDefault: false, reason } : { id, reason }); break; }
    case "admin/resources:createResource": { const { jurisdiction } = await mainFixtureRecords(ctx, input.tag); Object.assign(args, { jurisdictionId: jurisdiction._id, type: "act", title: `${marker} resource`, issuer: "E2E fixture", officialCitation: `${marker}-create`, sourceUrl: "https://example.invalid/matrix", topics: ["fixture"], effectiveDate: "2026-01-01", reason }); break; }
    case "admin/resources:updateResource":
    case "admin/resources:archiveResource":
    case "admin/resources:markResourceRepealed": { const id = await createMatrixResource(ctx, input.tag, input.key, input.path.split(":")[1]); if (input.path.endsWith("updateResource")) Object.assign(args, { id, title: `${marker} updated`, issuer: "E2E fixture", officialCitation: `${marker}-updated`, sourceUrl: "https://example.invalid/updated", topics: ["fixture"], effectiveDate: "2026-01-01", reason }); else if (input.path.endsWith("markResourceRepealed")) Object.assign(args, { id, repealDate: "2026-03-01", reason }); else Object.assign(args, { id, reason }); break; }
    case "admin/reviews:submitForReview": { const item = await createMatrixVersion(ctx, input.tag, input.key, "submit", "draft", actor.userId); Object.assign(args, { versionId: item.versionId, reason, idempotencyKey: input.key }); break; }
    case "admin/reviews:approveVersion":
    case "admin/reviews:rejectVersion": { const submitter = (await fixtureActor(ctx, input.tag, "content_manager")).userId; const item = await createMatrixVersion(ctx, input.tag, input.key, input.path.endsWith("approveVersion") ? "approve" : "reject", "ready_for_review", submitter); Object.assign(args, { versionId: item.versionId, checklistAnswers: { sourceAuthentic: true, metadataAccurate: true, extractionReviewed: true, citationsVerified: true, evaluationPassed: true }, evaluationRunId: `${input.key}.evaluation`, reason, idempotencyKey: input.key }); break; }
    case "admin/publication:publishVersion":
    case "admin/publication:unpublishVersion":
    case "admin/publication:rollbackVersion": { const operation = input.path.includes("unpublish") ? "unpublish" : input.path.includes("rollback") ? "rollback" : "publish"; const status = operation === "publish" ? "approved" : operation === "unpublish" ? "published" : "superseded"; const item = await createMatrixVersion(ctx, input.tag, input.key, operation, status, actor.userId); if (operation === "rollback") { const { storageId } = await mainFixtureRecords(ctx, input.tag); const activeId = await ctx.db.insert("documentVersions", { resourceId: item.resourceId, versionNumber: 2, originalStorageId: storageId, filename: `${marker}-active.pdf`, mimeType: "application/pdf", byteSize: 18, sha256: "f".repeat(64), sourceUrl: "https://example.invalid/active", effectiveDate: "2026-03-01", status: "published", groundxStagingDocumentId: `${marker}-active-stage`, groundxProductionDocumentId: `${marker}-active-prod`, submittedBy: actor.userId, submittedAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() }); await ctx.db.patch(item.resourceId, { activeVersionId: activeId }); } await insertStepUp(ctx, actor, `document_${operation}`, item.versionId, input.key); Object.assign(args, { versionId: item.versionId, confirmation: `${operation.toUpperCase()} ${item.versionId}`, reason, idempotencyKey: input.key }); break; }
    case "admin/billing:grantQuotaOverride": Object.assign(args, { userId: `fixture:${input.tag}:${input.key}`, limit: 25, startsAt: Date.now(), expiresAt: Date.now() + 60_000, reason, confirmation: "", idempotencyKey: input.key }); break;
    case "admin/billing:revokeQuotaOverride": { const operationId = await ctx.db.insert("adminOperations", { actorId: `fixture:${input.tag}`, action: "e2e.fixture", targetId: input.tag, idempotencyKey: `${input.key}.grant`, requestFingerprint: "{}", correlationId: `${marker}-grant`, status: "succeeded", createdAt: Date.now(), updatedAt: Date.now() }); const overrideId = await ctx.db.insert("quotaOverrides", { userId: `fixture:${input.tag}:${input.key}`, limit: 25, startsAt: Date.now(), expiresAt: Date.now() + 60_000, grantedBy: `fixture:${input.tag}`, reason, active: true, grantOperationId: operationId, createdAt: Date.now(), updatedAt: Date.now() }); Object.assign(args, { overrideId, reason, idempotencyKey: input.key }); break; }
    case "admin/jobs:enqueueJob": Object.assign(args, { type: "poll_process", targetType: "e2e_fixture", targetId: marker, payload: { processId: `${marker}-process` }, idempotencyKey: input.key }); break;
    case "admin/jobs:retryJob":
    case "admin/jobs:cancelJob": { const retry = input.path.endsWith("retryJob"); const jobId = await ctx.db.insert("integrationJobs", { type: "poll_process", targetType: "e2e_fixture", targetId: marker, payload: JSON.stringify({ processId: `${marker}-process` }), actorId: actor.userId, actorRoles: [input.role], idempotencyKey: `${input.key}.seed`, requestFingerprint: "{}", correlationId: `${marker}-seed`, callbackTokenHash: "0".repeat(64), status: retry ? "failed" : "queued", attemptCount: retry ? 1 : 0, ...(retry ? { lastErrorKind: "network" as const } : { nextAttemptAt: Date.now() }), createdAt: Date.now(), updatedAt: Date.now() }); Object.assign(args, { jobId, reason, idempotencyKey: input.key }); break; }
    case "admin/operations:createIncident": Object.assign(args, { title: `${marker} incident`, severity: "low", reason, idempotencyKey: input.key }); break;
    case "admin/operations:addIncidentNote":
    case "admin/operations:updateIncident": { const incidentId = await ctx.db.insert("systemIncidents", { title: `${marker} incident`, severity: "low", status: "open", createdBy: `fixture:${input.tag}`, createdAt: Date.now(), updatedAt: Date.now() }); Object.assign(args, input.path.endsWith("addIncidentNote") ? { incidentId, note: "Tagged fixture incident note", reason, idempotencyKey: input.key } : { incidentId, status: "investigating", severity: "medium", ownerId: actor.userId, reason, idempotencyKey: input.key }); break; }
  }
  return { path: input.path, role: input.role, args, success: entry.success };
}

async function readMatrixOperation(ctx: MutationCtx, input: { tag: string; path: string; role: (typeof FIXED_ROLES)[number]; key: string; payload: unknown }) {
  const entry = E2E_PRIVILEGED_FUNCTIONS.find((row) => row.path === input.path);
  if (!entry || !input.payload || typeof input.payload !== "object") throw new ConvexError("E2E_MATRIX_OPERATION_INVALID");
  const body = input.payload as { args?: Record<string, unknown>; result?: unknown };
  const args = body.args ?? {};
  const result = body.result as Record<string, unknown> | string | undefined;
  const actor = await fixtureActor(ctx, input.tag, input.role);
  const operation = (await ctx.db.query("adminOperations").withIndex("by_actorId_and_idempotencyKey", (q) => q.eq("actorId", actor.userId).eq("idempotencyKey", input.key)).take(2))[0];
  const proofs = (await ctx.db.query("adminStepUpProofs").take(500)).filter((row) => row.actorId === actor.userId && row.idempotencyKey === input.key);
  const authUser = async (id: unknown) => await ctx.runQuery(components.betterAuth.adapter.findOne, { model: "user", where: [{ field: "_id", operator: "eq", value: String(id) }] }) as Record<string, unknown> | null;
  const authSessions = async (id: unknown) => await ctx.runQuery(components.betterAuth.adapter.findMany, { model: "session", where: [{ field: "userId", operator: "eq", value: String(id) }], select: ["id", "userId"], paginationOpts: { numItems: 20, cursor: null } }) as { page: unknown[] };
  let terminal = false;
  let state: Record<string, unknown> = {};

  if (input.path === "admin/roles:setAdminRoles" || input.path === "admin/users:assignRoles") {
    const user = await authUser(input.path.includes("roles:set") ? args.targetUserId : args.userId);
    terminal = user?.role === "content_manager" && (input.path.includes("roles:set") || (operation?.status === "succeeded" && proofs[0]?.consumedAt !== undefined));
    state = { role: user?.role ?? null, operationStatus: operation?.status ?? null, proofConsumed: proofs[0]?.consumedAt !== undefined };
  } else if (input.path === "admin/users:banUser" || input.path === "admin/users:unbanUser") {
    const user = await authUser(args.userId);
    const banned = user?.banned === true;
    terminal = operation?.status === "succeeded" && banned === (input.path === "admin/users:banUser");
    state = { banned, operationStatus: operation?.status ?? null };
  } else if (input.path === "admin/users:revokeSession" || input.path === "admin/users:revokeAllSessions") {
    const sessions = await authSessions(args.userId);
    terminal = operation?.status === "succeeded" && sessions.page.length === 0;
    state = { sessionCount: sessions.page.length, operationStatus: operation?.status ?? null };
  } else if (input.path === "admin/users:resendVerification") {
    const rows = await ctx.db.query("verificationEmailRequests").withIndex("by_targetUserId_and_createdAt", (q) => q.eq("targetUserId", String(args.userId))).take(2);
    terminal = operation?.status === "queued" && rows[0]?.status === "completed";
    state = { operationStatus: operation?.status ?? null, deliveryStatus: rows[0]?.status ?? null };
  } else if (input.path === "admin/users:startImpersonation") {
    terminal = operation?.status === "authorized" && proofs[0]?.consumedAt !== undefined;
    state = { operationStatus: operation?.status ?? null, proofConsumed: proofs[0]?.consumedAt !== undefined };
  } else if (input.path === "admin/users:queueUserDeletion") {
    const rows = await ctx.db.query("userDeletionRequests").withIndex("by_targetUserId_and_status", (q) => q.eq("targetUserId", String(args.userId)).eq("status", "queued")).take(2);
    terminal = operation?.status === "queued" && rows.length === 1 && proofs[0]?.consumedAt !== undefined;
    state = { operationStatus: operation?.status ?? null, requestStatus: rows[0]?.status ?? null, proofConsumed: proofs[0]?.consumedAt !== undefined };
  } else if (input.path === "admin/conversations:createAccessGrant") {
    const grant = typeof result === "object" && result ? await ctx.db.get(String(result.grantId) as Id<"adminAccessGrants">) : null;
    terminal = grant?.adminId === actor.userId && grant.chatSessionId === args.chatId;
    state = { grantExists: Boolean(grant), actorBound: grant?.adminId === actor.userId };
  } else if (input.path === "admin/exports:queueConversationExport") {
    const correlationId = typeof result === "object" && result ? String(result.correlationId) : "";
    const rows = await ctx.db.query("adminExports").withIndex("by_correlationId", (q) => q.eq("correlationId", correlationId)).take(2);
    terminal = operation?.status === "queued" && rows[0]?.status === "ready" && proofs[0]?.consumedAt !== undefined;
    state = { operationStatus: operation?.status ?? null, exportStatus: rows[0]?.status ?? null, proofConsumed: proofs[0]?.consumedAt !== undefined };
  } else if (input.path === "admin/exports:issueConversationExportReference") {
    const rows = await ctx.db.query("adminExports").withIndex("by_correlationId", (q) => q.eq("correlationId", String(args.correlationId))).take(2);
    const references = rows[0] ? await ctx.db.query("exportDownloadReferences").withIndex("by_exportId_and_createdAt", (q) => q.eq("exportId", rows[0]._id)).take(2) : [];
    terminal = rows[0]?.status === "ready" && references.length === 1;
    state = { exportStatus: rows[0]?.status ?? null, referenceCount: references.length };
  } else if (input.path === "admin/documents:generateUploadUrl") {
    const events = await ctx.db.query("auditEvents").withIndex("by_actorId_and_createdAt", (q) => q.eq("actorId", actor.userId)).order("desc").take(10);
    terminal = events.some((row) => row.action === "document.upload_url_generated" && row.outcome === "success");
    state = { audited: terminal };
  } else if (input.path === "admin/documents:createDocumentVersion") {
    const version = typeof result === "string" ? await ctx.db.get(result as Id<"documentVersions">) : null;
    terminal = version?.status === "draft" && version.resourceId === args.resourceId && version.originalStorageId === args.storageId;
    state = { status: version?.status ?? null, resourceId: version?.resourceId ?? null };
  } else if (input.path.startsWith("admin/resources:")) {
    const id = typeof result === "string" ? result : String(args.id ?? (typeof result === "object" && result ? result._id : ""));
    const jurisdiction = input.path.includes("Jurisdiction") ? await ctx.db.get(id as Id<"jurisdictions">) : null;
    const resource = !input.path.includes("Jurisdiction") ? await ctx.db.get(id as Id<"legalResources">) : null;
    const expected = input.path.includes("archive") ? "archived" : input.path.includes("Repealed") ? "repealed" : input.path.includes("enable") ? "enabled" : input.path.includes("createJurisdiction") ? "draft" : input.path.includes("createResource") ? "active" : undefined;
    const row = jurisdiction ?? resource;
    terminal = Boolean(row) && (expected === undefined || row?.status === expected);
    state = { exists: Boolean(row), status: row?.status ?? null };
  } else if (input.path.startsWith("admin/reviews:")) {
    const version = await ctx.db.get(String(args.versionId) as Id<"documentVersions">);
    const expected = input.path.endsWith("submitForReview") ? "ready_for_review" : input.path.endsWith("approveVersion") ? "approved" : "rejected";
    terminal = version?.status === expected && operation?.status === "succeeded";
    state = { status: version?.status ?? null, operationStatus: operation?.status ?? null };
  } else if (input.path.startsWith("admin/publication:")) {
    const jobId = typeof result === "object" && result ? String(result.jobId) : "";
    const job = jobId ? await ctx.db.get(jobId as Id<"integrationJobs">) : null;
    const version = await ctx.db.get(String(args.versionId) as Id<"documentVersions">);
    const expected = input.path.endsWith("unpublishVersion") ? "unpublished" : "published";
    terminal = job?.status === "succeeded" && version?.status === expected && proofs[0]?.consumedAt !== undefined;
    state = { jobStatus: job?.status ?? null, versionStatus: version?.status ?? null, proofConsumed: proofs[0]?.consumedAt !== undefined };
  } else if (input.path.startsWith("admin/billing:")) {
    const overrideId = typeof result === "object" && result ? String(result.overrideId) : "";
    const override = overrideId ? await ctx.db.get(overrideId as Id<"quotaOverrides">) : null;
    const expectedActive = input.path.endsWith("grantQuotaOverride");
    terminal = Boolean(override) && override?.active === expectedActive;
    state = { active: override?.active ?? null, operationStatus: operation?.status ?? null };
  } else if (input.path.startsWith("admin/jobs:")) {
    const jobId = input.path.endsWith("enqueueJob") && typeof result === "object" && result ? String(result.jobId) : String(args.jobId);
    const job = await ctx.db.get(jobId as Id<"integrationJobs">);
    const expected = input.path.endsWith("cancelJob") ? "cancelled" : "succeeded";
    terminal = job?.status === expected;
    state = { jobStatus: job?.status ?? null };
  } else if (input.path.startsWith("admin/operations:")) {
    const incidentId = typeof result === "object" && result ? String(result.incidentId) : String(args.incidentId);
    const incident = await ctx.db.get(incidentId as Id<"systemIncidents">);
    const timeline = incident ? await ctx.db.query("incidentTimeline").withIndex("by_incidentId_and_createdAt", (q) => q.eq("incidentId", incident._id)).take(20) : [];
    terminal = Boolean(incident) && (input.path.endsWith("addIncidentNote") ? timeline.some((row) => row.kind === "note") : input.path.endsWith("updateIncident") ? incident?.status === "investigating" && incident.severity === "medium" : timeline.some((row) => row.kind === "created"));
    state = { status: incident?.status ?? null, severity: incident?.severity ?? null, timelineKinds: timeline.map((row) => row.kind) };
  }
  return { path: input.path, success: entry.success, terminal, state };
}

const controlOperationValidator = v.union(
  v.literal("publication_failed"),
  v.literal("publication_succeeded"),
  v.literal("expire_conversation_grant"),
  v.literal("read_state"),
  v.literal("run_retention"),
  v.literal("prepare_matrix_operation"),
  v.literal("read_matrix_operation"),
);

export const applyControl = internalMutation({
  args: { tag: v.string(), operation: controlOperationValidator, versionId: v.optional(v.id("documentVersions")), path: v.optional(v.string()), role: v.optional(matrixRoleValidator), key: v.optional(v.string()), payload: v.optional(v.any()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireFixtureEnvironment(); requireTag(args.tag);
    if (args.operation === "prepare_matrix_operation") {
      if (!args.path || !args.role || !args.key) throw new ConvexError("E2E_MATRIX_ARGUMENTS_REQUIRED");
      return await prepareMatrixOperation(ctx, { tag: args.tag, path: args.path, role: args.role, key: args.key });
    }
    if (args.operation === "read_matrix_operation") {
      if (!args.path || !args.role || !args.key) throw new ConvexError("E2E_MATRIX_ARGUMENTS_REQUIRED");
      return await readMatrixOperation(ctx, { tag: args.tag, path: args.path, role: args.role, key: args.key, payload: args.payload });
    }
    const jurisdiction = await ctx.db.query("jurisdictions").withIndex("by_slug", (q) => q.eq("slug", args.tag)).unique();
    if (!jurisdiction) throw new ConvexError("E2E_FIXTURE_NOT_FOUND");
    const resources = await ctx.db.query("legalResources")
      .withIndex("by_jurisdictionId_and_updatedAt", (q) => q.eq("jurisdictionId", jurisdiction._id)).take(10);
    const resource = resources.find((row) => row.createdBy === `fixture:${args.tag}`);
    if (!resource) throw new ConvexError("E2E_FIXTURE_NOT_FOUND");

    if (args.operation === "run_retention") {
      // Never call the global retention engine from fixtures. This boundary
      // touches only the tagged callback job and reports its own state.
      const callbackJob = await ctx.db.query("integrationJobs")
        .withIndex("by_targetType_and_targetId", (q) => q.eq("targetType", "e2e_fixture").eq("targetId", args.tag)).unique();
      if (!callbackJob) throw new ConvexError("E2E_FIXTURE_NOT_FOUND");
      await ctx.db.patch(callbackJob._id, {
        payload: "{}", lastErrorKind: undefined, retentionPending: false,
        retentionRedactedAt: Date.now(), updatedAt: Date.now(),
      });
    } else if (args.operation === "expire_conversation_grant") {
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
    const callbackJob = await ctx.db.query("integrationJobs")
      .withIndex("by_targetType_and_targetId", (q) => q.eq("targetType", "e2e_fixture").eq("targetId", args.tag)).unique();
    return {
      activeVersionId: resource.activeVersionId ?? null,
      versions: versions.map((row) => ({ id: row._id, versionNumber: row.versionNumber, status: row.status, failureSummary: row.failureSummary ?? null })),
      grantActive: grants.some((row) => row.chatSessionId === chat?._id && row.correlationId === `${args.tag}-grant` && row.expiresAt > Date.now() && row.revokedAt === undefined),
      retention: { deletedTotal: callbackJob?.retentionRedactedAt ? 1 : 0, lastSuccessfulAt: callbackJob?.retentionRedactedAt ?? null },
      callbackJob: callbackJob ? { status: callbackJob.status, payload: callbackJob.payload, retentionRedactedAt: callbackJob.retentionRedactedAt ?? null } : null,
    };
  },
});

const applyControlRef = makeFunctionReference<"mutation">("admin/e2eFixtures:applyControl");
export const control = internalAction({
  args: {
    tag: v.string(),
    operation: v.union(controlOperationValidator, v.literal("run_retention")),
    versionId: v.optional(v.id("documentVersions")),
    path: v.optional(v.string()),
    role: v.optional(matrixRoleValidator),
    key: v.optional(v.string()),
    payload: v.optional(v.any()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireFixtureEnvironment(); requireTag(args.tag);
    return await ctx.runMutation(applyControlRef, args);
  },
});
