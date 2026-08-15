import { makeFunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import { hashPassword } from "better-auth/crypto";
import { components } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalAction, internalMutation } from "../_generated/server";
import { hashCallbackToken } from "./jobs";
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
const FIXTURE_COUNTRY_STAGING_BUCKET_ID = "910011";
const FIXTURE_COUNTRY_PRODUCTION_BUCKET_ID = "910012";
const FIXTURE_TOWN_STAGING_BUCKET_ID = "910021";
const FIXTURE_TOWN_PRODUCTION_BUCKET_ID = "910022";
const FIXTURE_PUBLIC_ORGANIZATION_STAGING_BUCKET_ID = "910031";
const FIXTURE_PUBLIC_ORGANIZATION_PRODUCTION_BUCKET_ID = "910032";
const FIXTURE_MEMBER_ORGANIZATION_STAGING_BUCKET_ID = "910041";
const FIXTURE_MEMBER_ORGANIZATION_PRODUCTION_BUCKET_ID = "910042";
const SHA_RE = /^[a-f0-9]{40}$/;

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

function fixtureCommitIdentity() {
  const approvedCommitSha = process.env.ADMIN_E2E_APPROVED_COMMIT_SHA;
  const deployedCommitSha = process.env.ADMIN_E2E_DEPLOYED_COMMIT_SHA;
  if (!approvedCommitSha || !deployedCommitSha
    || !SHA_RE.test(approvedCommitSha)
    || !SHA_RE.test(deployedCommitSha)
    || approvedCommitSha !== deployedCommitSha) {
    throw new ConvexError("E2E_FIXTURE_COMMIT_MISMATCH");
  }
  if (process.env.ADMIN_ENVIRONMENT !== process.env.ADMIN_E2E_TARGET_ENV) {
    throw new ConvexError("E2E_FIXTURE_ENVIRONMENT_MISMATCH");
  }
  if (process.env.BILLING_ENABLED !== "false") {
    throw new ConvexError("E2E_FIXTURE_BILLING_MUST_BE_DISABLED");
  }
  return { approvedCommitSha, deployedCommitSha };
}

function fixtureSlug(tag: string, suffix: string) {
  return suffix ? `${tag}-${suffix}` : tag;
}

async function exactTaggedJurisdiction(
  ctx: MutationCtx,
  tag: string,
  suffix: string,
) {
  const rows = await ctx.db.query("jurisdictions")
    .withIndex("by_slug", (q) => q.eq("slug", fixtureSlug(tag, suffix)))
    .take(2);
  if (rows.length > 1) throw new ConvexError("E2E_FIXTURE_STATE_INVALID");
  const row = rows[0];
  if (row && row.createdBy !== `fixture:${tag}`) {
    throw new ConvexError("E2E_FIXTURE_OWNERSHIP_MISMATCH");
  }
  return row ?? null;
}

async function exactTaggedOrganization(
  ctx: MutationCtx,
  tag: string,
  suffix: string,
) {
  const rows = await ctx.db.query("organizations")
    .withIndex("by_slug", (q) => q.eq("slug", fixtureSlug(tag, suffix)))
    .take(2);
  if (rows.length > 1) throw new ConvexError("E2E_FIXTURE_STATE_INVALID");
  const row = rows[0];
  if (row && row.createdBy !== `fixture:${tag}`) {
    throw new ConvexError("E2E_FIXTURE_OWNERSHIP_MISMATCH");
  }
  return row ?? null;
}

async function listFixtureUsers(ctx: MutationCtx, tag: string) {
  const owned = await ctx.db.query("e2eFixtureOwnership")
    .withIndex("by_tag_and_kind", (q) => q.eq("tag", tag).eq("kind", "better_auth_user"))
    .take(501);
  if (owned.length > 500) throw new ConvexError("E2E_FIXTURE_OWNERSHIP_BOUNDS_EXCEEDED");
  const ownedIds = new Set(owned.map((row) => row.targetId));
  const matches = new Map<string, { userId: string; email: string }>();
  let cursor: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const result = await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: "user",
      select: ["id", "email"],
      paginationOpts: { numItems: 100, cursor },
    }) as { page: Array<{ _id: string; email?: string }>; isDone: boolean; continueCursor: string };
    for (const user of result.page) {
      if (typeof user.email === "string" && ownedIds.has(user._id)) {
        matches.set(user._id, { userId: user._id, email: user.email });
      }
    }
    if (result.isDone) break;
    cursor = result.continueCursor;
  }
  return [...matches.values()];
}

async function cleanupFixture(ctx: MutationCtx, tag: string, options: { deleteOwnership?: boolean } = {}) {
  let deleted = 0;
  const fixtureOwnership = await ctx.db.query("e2eFixtureOwnership")
    .withIndex("by_tag_and_kind", (q) => q.eq("tag", tag))
    .take(501);
  if (fixtureOwnership.length > 500) throw new ConvexError("E2E_FIXTURE_OWNERSHIP_BOUNDS_EXCEEDED");
  const fixtureUsers = await listFixtureUsers(ctx, tag);
  const fixtureUserIds = new Set(
    fixtureOwnership.filter((row) => row.kind === "better_auth_user").map((row) => row.targetId),
  );
  const fixtureOwnerIds = new Set([`fixture:${tag}`, ...fixtureUserIds]);
  const registeredIncidentIds = new Set(
    fixtureOwnership.filter((row) => row.kind === "system_incident").map((row) => row.targetId),
  );
  const registeredOperationIds = new Set(
    fixtureOwnership.filter((row) => row.kind === "admin_operation").map((row) => row.targetId),
  );
  const registeredOverrideIds = new Set(
    fixtureOwnership.filter((row) => row.kind === "quota_override").map((row) => row.targetId),
  );
  const fixtureVersionIds = new Set<string>();
  const fixtureOperationIds = new Set<Id<"adminOperations">>();
  const fixtureStorageIds = new Set<Id<"_storage">>();

  const [country, town, publicOrganizationJurisdiction, memberOrganizationJurisdiction] = await Promise.all([
    exactTaggedJurisdiction(ctx, tag, "ghana"),
    exactTaggedJurisdiction(ctx, tag, "accra"),
    exactTaggedJurisdiction(ctx, tag, "public-organization"),
    exactTaggedJurisdiction(ctx, tag, "member-organization"),
  ]);
  const [publicOrganization, memberOrganization] = await Promise.all([
    exactTaggedOrganization(ctx, tag, "public-organization"),
    exactTaggedOrganization(ctx, tag, "member-organization"),
  ]);
  if ((publicOrganizationJurisdiction?.organizationId ?? null) !== (publicOrganization?._id ?? null)
    || (memberOrganizationJurisdiction?.organizationId ?? null) !== (memberOrganization?._id ?? null)) {
    throw new ConvexError("E2E_FIXTURE_OWNERSHIP_MISMATCH");
  }
  const typedJurisdictions = [country, town, publicOrganizationJurisdiction, memberOrganizationJurisdiction]
    .filter((row): row is NonNullable<typeof row> => row !== null);
  const geographicProfiles = (await Promise.all([country, town].map(async (row) => row
    ? await ctx.db.query("geographicJurisdictions").withIndex("by_jurisdictionId", (q) => q.eq("jurisdictionId", row._id)).take(2)
    : []))).flat();
  const organizationalProfiles = (await Promise.all([publicOrganizationJurisdiction, memberOrganizationJurisdiction].map(async (row) => row
    ? await ctx.db.query("organizationalJurisdictions").withIndex("by_jurisdictionId", (q) => q.eq("jurisdictionId", row._id)).take(2)
    : []))).flat();
  if (geographicProfiles.length > 2 || organizationalProfiles.length > 2) {
    throw new ConvexError("E2E_FIXTURE_STATE_INVALID");
  }
  for (const profile of organizationalProfiles) {
    const scopes = await ctx.db.query("organizationGeographicScopes")
      .withIndex("by_organizationalJurisdictionId_and_geographicJurisdictionId", (q) =>
        q.eq("organizationalJurisdictionId", profile._id))
      .take(9);
    for (const scope of scopes) { await ctx.db.delete(scope._id); deleted += 1; }
  }
  for (const row of [country, town]) {
    if (!row) continue;
    const aliases = await ctx.db.query("geographicJurisdictionAliases")
      .withIndex("by_jurisdictionId_and_normalizedAlias", (q) => q.eq("jurisdictionId", row._id))
      .take(20);
    for (const alias of aliases) { await ctx.db.delete(alias._id); deleted += 1; }
  }
  for (const organization of [publicOrganization, memberOrganization]) {
    if (!organization) continue;
    for (const status of ["active", "inactive"] as const) {
      const memberships = await ctx.db.query("organizationMemberships")
        .withIndex("by_organizationId_and_status", (q) => q.eq("organizationId", organization._id).eq("status", status))
        .take(101);
      for (const membership of memberships) {
        if (!fixtureUserIds.has(membership.userId)) throw new ConvexError("E2E_FIXTURE_OWNERSHIP_MISMATCH");
        await ctx.db.delete(membership._id); deleted += 1;
      }
    }
  }
  for (const profile of organizationalProfiles) { await ctx.db.delete(profile._id); deleted += 1; }
  for (const profile of geographicProfiles) { await ctx.db.delete(profile._id); deleted += 1; }
  for (const jurisdiction of typedJurisdictions) { await ctx.db.delete(jurisdiction._id); deleted += 1; }
  for (const organization of [publicOrganization, memberOrganization]) {
    if (organization) { await ctx.db.delete(organization._id); deleted += 1; }
  }

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
    (row) => row.slug === tag || row.createdBy === `fixture:${tag}` || fixtureUserIds.has(row.createdBy),
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

  const fixtureIncidentIds = new Set(registeredIncidentIds);
  const incidentActions = new Set(["incident_create", "incident_note", "incident_update"]);
  const rememberOperation = (operation: Doc<"adminOperations">) => {
    fixtureOperationIds.add(operation._id);
    if (incidentActions.has(operation.action)) fixtureIncidentIds.add(operation.targetId);
  };
  for (const actorId of fixtureOwnerIds) {
    for (const operation of await ctx.db.query("adminOperations")
      .withIndex("by_actorId_and_idempotencyKey", (q) => q.eq("actorId", actorId)).take(500)) {
      rememberOperation(operation);
    }
  }
  for (const operationId of registeredOperationIds) {
    const operation = await ctx.db.get(operationId as Id<"adminOperations">);
    if (operation) rememberOperation(operation);
  }
  // Recover seed operations written before exact ownership registration was
  // introduced. Both action and target are fixture-control constants.
  for (const operation of await ctx.db.query("adminOperations")
    .withIndex("by_action_and_targetId_and_createdAt", (q) => q.eq("action", "e2e.fixture").eq("targetId", tag)).take(100)) {
    rememberOperation(operation);
  }

  for (const incidentId of fixtureIncidentIds) {
    const incident = await ctx.db.get(incidentId as Id<"systemIncidents">);
    if (!incident) continue;
    for (const row of await ctx.db.query("incidentTimeline").withIndex("by_incidentId_and_createdAt", (q) => q.eq("incidentId", incident._id)).take(500)) {
      await ctx.db.delete(row._id); deleted += 1;
    }
    await ctx.db.delete(incident._id); deleted += 1;
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
  for (const operationId of fixtureOperationIds) {
    for (const row of await ctx.db.query("jobControlResults").withIndex("by_operationId", (q) => q.eq("operationId", operationId)).take(20)) {
      await ctx.db.delete(row._id); deleted += 1;
    }
    if (await ctx.db.get(operationId)) { await ctx.db.delete(operationId); deleted += 1; }
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
  for (const userId of fixtureOwnerIds) {
    for (const usage of await ctx.db.query("dailyUsage").withIndex("by_user_day", (q) => q.eq("userId", userId)).take(500)) {
      await ctx.db.delete(usage._id); deleted += 1;
    }
  }
  const fixtureOverrideIds = new Set<Id<"quotaOverrides">>();
  for (const userId of fixtureOwnerIds) {
    for (const override of await ctx.db.query("quotaOverrides")
      .withIndex("by_userId_and_startsAt", (q) => q.eq("userId", userId)).take(500)) {
      fixtureOverrideIds.add(override._id);
    }
  }
  for (const overrideId of registeredOverrideIds) {
    const override = await ctx.db.get(overrideId as Id<"quotaOverrides">);
    if (override) fixtureOverrideIds.add(override._id);
  }
  for (const operationId of fixtureOperationIds) {
    for (const override of await ctx.db.query("quotaOverrides")
      .withIndex("by_grantOperationId", (q) => q.eq("grantOperationId", operationId)).take(500)) {
      fixtureOverrideIds.add(override._id);
    }
    for (const override of await ctx.db.query("quotaOverrides")
      .withIndex("by_revokeOperationId", (q) => q.eq("revokeOperationId", operationId)).take(500)) {
      fixtureOverrideIds.add(override._id);
    }
  }
  for (const overrideId of fixtureOverrideIds) {
    await ctx.db.delete(overrideId); deleted += 1;
  }
  for (const userId of fixtureUserIds) {
    for (const event of await ctx.db.query("auditEvents").withIndex("by_actorId_and_createdAt", (q) => q.eq("actorId", userId)).take(200)) {
      await ctx.db.delete(event._id); deleted += 1;
    }
  }
  for (const outcome of await ctx.db.query("e2eProviderStubOutcomes").withIndex("by_tag", (q) => q.eq("tag", tag)).take(500)) {
    await ctx.db.delete(outcome._id); deleted += 1;
  }
  if (options.deleteOwnership !== false) {
    for (const ownership of fixtureOwnership) {
      await ctx.db.delete(ownership._id); deleted += 1;
    }
  }
  for (const storageId of fixtureStorageIds) {
    if (await ctx.db.system.get("_storage", storageId)) await ctx.storage.delete(storageId);
  }
  return deleted;
}

async function globalCleanupBoundsExceeded(ctx: MutationCtx) {
  const scans = await Promise.all([
    ctx.db.query("chatSessions").take(501),
    ctx.db.query("adminAccessGrants").withIndex("by_expiresAt").take(501),
    ctx.db.query("jurisdictions").take(501),
    ctx.db.query("adminStepUpProofs").take(501),
    ctx.db.query("userDeletionRequests").take(501),
    ctx.db.query("verificationEmailRequests").take(501),
    ctx.db.query("adminExports").take(501),
    ctx.db.query("exportDownloadReferences").take(501),
    ctx.db.query("integrationJobs").take(501),
  ]);
  return scans.some((rows) => rows.length > 500);
}

const sessionManifestValidator = v.object({ userId: v.string(), sessionToken: v.string() });
const bootstrapResultValidator = v.object({
  tag: v.string(),
  providerTransport: v.literal("stub"),
  deployedCommitSha: v.string(),
  billingDisabled: v.literal(true),
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
  jurisdictionUsers: v.object({
    member: sessionManifestValidator,
    formerMember: sessionManifestValidator,
  }),
  records: v.object({
    chatId: v.id("chatSessions"), resourceId: v.id("legalResources"), publishedVersionId: v.id("documentVersions"),
    reviewVersionId: v.id("documentVersions"), conversationGrantId: v.id("adminAccessGrants"), jurisdictionId: v.id("jurisdictions"),
    separationVersionId: v.id("documentVersions"),
    userId: v.string(), stagingBucketId: v.string(), productionBucketId: v.string(),
    callbackToken: v.string(), callbackJobId: v.id("integrationJobs"), usageUserId: v.string(),
    jurisdictionCountryId: v.id("jurisdictions"), jurisdictionTownId: v.id("jurisdictions"),
    publicOrganizationJurisdictionId: v.id("jurisdictions"), jurisdictionMemberOnlyId: v.id("jurisdictions"),
    jurisdictionMemberId: v.id("organizationMemberships"), jurisdictionFormerMemberId: v.id("organizationMemberships"),
  }),
});

export const bootstrapRecords = internalMutation({
  args: { tag: v.string(), passwordHash: v.string(), publishedStorageId: v.id("_storage"), reviewStorageId: v.id("_storage"), separationStorageId: v.id("_storage") },
  returns: bootstrapResultValidator,
  handler: async (ctx, { tag, passwordHash, publishedStorageId, reviewStorageId, separationStorageId }) => {
    requireFixtureEnvironment(); requireTag(tag);
    const environment = process.env.ADMIN_E2E_TARGET_ENV!;
    const { approvedCommitSha, deployedCommitSha } = fixtureCommitIdentity();
    const panelRows = await ctx.db.query("featureFlags")
      .withIndex("by_key_and_environment", (q) => q.eq("key", "admin_panel").eq("environment", environment)).take(2);
    if (panelRows.length !== 1 || !panelRows[0].enabled) throw new ConvexError("E2E_ADMIN_PANEL_FLAG_REQUIRED");
    const [tagRuns, environmentRuns] = await Promise.all([
      ctx.db.query("e2eFixtureRuns").withIndex("by_tag", (q) => q.eq("tag", tag)).take(2),
      ctx.db.query("e2eFixtureRuns").withIndex("by_environment", (q) => q.eq("environment", environment as "test" | "preview")).take(2),
    ]);
    if (tagRuns.length !== 0 || environmentRuns.length !== 0) {
      throw new ConvexError("E2E_FIXTURE_RUN_ACTIVE");
    }
    await cleanupFixture(ctx, tag);
    const conflictingGhana = await ctx.db.query("jurisdictions")
      .withIndex("by_code", (q) => q.eq("code", "GH")).take(2);
    if (conflictingGhana.length !== 0) throw new ConvexError("E2E_FIXTURE_SHARED_TARGET");

    const now = Date.now();
    const flagRows = await ctx.db.query("featureFlags")
      .withIndex("by_key_and_environment", (q) => q.eq("key", "unified_jurisdictions").eq("environment", environment)).take(2);
    if (flagRows.length > 1) throw new ConvexError("E2E_FIXTURE_SHARED_TARGET");
    const existingFlag = flagRows[0];
    const priorFlag = existingFlag ? {
      kind: "present" as const,
      rowId: existingFlag._id,
      enabled: existingFlag.enabled,
      updatedAt: existingFlag.updatedAt,
      ...(existingFlag.updatedBy !== undefined ? { updatedBy: existingFlag.updatedBy } : {}),
    } : { kind: "absent" as const };
    const fixtureFlagWrite = {
      enabled: true,
      updatedAt: Math.max(now, (existingFlag?.updatedAt ?? 0) + 1),
      updatedBy: `fixture:${tag}`,
    };
    const flagId = existingFlag?._id ?? await ctx.db.insert("featureFlags", {
      key: "unified_jurisdictions",
      environment,
      ...fixtureFlagWrite,
    });
    if (existingFlag) await ctx.db.patch(existingFlag._id, fixtureFlagWrite);
    const runId = await ctx.db.insert("e2eFixtureRuns", {
      tag,
      environment: environment as "test" | "preview",
      state: "bootstrapping",
      priorFlag,
      fixtureFlagWrite: { rowId: flagId, ...fixtureFlagWrite },
      approvedCommitSha,
      deployedCommitSha,
      createdAt: now,
      updatedAt: now,
    });
    const sessions = {} as Record<(typeof FIXED_ROLES)[number], { userId: string; sessionToken: string }>;
    const createUser = async (key: string, role: string, twoFactorEnabled: boolean, assured: boolean) => {
      const user = await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "user", data: {
        name: `${key} E2E fixture`, email: `${key}.${tag}@e2e.invalid`, emailVerified: true, createdAt: now, updatedAt: now,
        role, banned: false, twoFactorEnabled,
      } } });
      const token = `${tag}_${crypto.randomUUID().replaceAll("-", "")}`;
      await ctx.db.insert("e2eFixtureOwnership", { tag, kind: "better_auth_user", targetId: user._id, createdAt: now });
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
    const member = await createUser("member", "user", false, false);
    const formerMember = await createUser("former_member", "user", false, false);

    const jurisdictionCountryId = await ctx.db.insert("jurisdictions", {
      code: "GH", name: `${tag} Ghana`, slug: fixtureSlug(tag, "ghana"), status: "enabled", isDefault: true,
      stagingBucketId: FIXTURE_COUNTRY_STAGING_BUCKET_ID, productionBucketId: FIXTURE_COUNTRY_PRODUCTION_BUCKET_ID,
      providerSyncState: "synced", kind: "geographic", visibility: "public", legacyCountryCode: "GH",
      createdBy: `fixture:${tag}`, updatedBy: `fixture:${tag}`, createdAt: now, updatedAt: now,
    });
    const countryProfileId = await ctx.db.insert("geographicJurisdictions", {
      jurisdictionId: jurisdictionCountryId, googlePlaceId: `fixture-${tag}-ghana`, level: "country", countryCode: "GH",
      latitude: 7.9465, longitude: -1.0232, formattedAddress: "Ghana", createdAt: now, updatedAt: now,
    });
    const jurisdictionTownId = await ctx.db.insert("jurisdictions", {
      name: `${tag} Accra`, slug: fixtureSlug(tag, "accra"), status: "enabled", isDefault: false,
      stagingBucketId: FIXTURE_TOWN_STAGING_BUCKET_ID, productionBucketId: FIXTURE_TOWN_PRODUCTION_BUCKET_ID,
      providerSyncState: "synced", kind: "geographic", visibility: "public",
      createdBy: `fixture:${tag}`, updatedBy: `fixture:${tag}`, createdAt: now, updatedAt: now,
    });
    const townProfileId = await ctx.db.insert("geographicJurisdictions", {
      jurisdictionId: jurisdictionTownId, googlePlaceId: `fixture-${tag}-accra`, level: "town", countryCode: "GH",
      latitude: 5.6037, longitude: -0.187, formattedAddress: "Accra, Ghana", parentJurisdictionId: jurisdictionCountryId,
      createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("geographicJurisdictionAliases", {
      jurisdictionId: jurisdictionTownId, normalizedAlias: "accra", source: `fixture:${tag}`, createdAt: now,
    });

    const publicOrganizationId = await ctx.db.insert("organizations", {
      name: `${tag} Public Organization`, slug: fixtureSlug(tag, "public-organization"), class: "professional_association",
      status: "active", createdBy: `fixture:${tag}`, updatedBy: `fixture:${tag}`, createdAt: now, updatedAt: now,
    });
    const publicOrganizationJurisdictionId = await ctx.db.insert("jurisdictions", {
      name: `${tag} Public Organization`, slug: fixtureSlug(tag, "public-organization"), status: "enabled", isDefault: false,
      stagingBucketId: FIXTURE_PUBLIC_ORGANIZATION_STAGING_BUCKET_ID, productionBucketId: FIXTURE_PUBLIC_ORGANIZATION_PRODUCTION_BUCKET_ID,
      providerSyncState: "synced", kind: "organizational", visibility: "public", organizationId: publicOrganizationId,
      createdBy: `fixture:${tag}`, updatedBy: `fixture:${tag}`, createdAt: now, updatedAt: now,
    });
    const publicOrganizationProfileId = await ctx.db.insert("organizationalJurisdictions", {
      jurisdictionId: publicOrganizationJurisdictionId, scopeMode: "linked_geographies", createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("organizationGeographicScopes", {
      organizationalJurisdictionId: publicOrganizationProfileId, geographicJurisdictionId: countryProfileId, createdAt: now,
    });

    const memberOrganizationId = await ctx.db.insert("organizations", {
      name: `${tag} Member Organization`, slug: fixtureSlug(tag, "member-organization"), class: "university",
      status: "active", createdBy: `fixture:${tag}`, updatedBy: `fixture:${tag}`, createdAt: now, updatedAt: now,
    });
    const jurisdictionMemberOnlyId = await ctx.db.insert("jurisdictions", {
      name: `${tag} Member Organization`, slug: fixtureSlug(tag, "member-organization"), status: "enabled", isDefault: false,
      stagingBucketId: FIXTURE_MEMBER_ORGANIZATION_STAGING_BUCKET_ID, productionBucketId: FIXTURE_MEMBER_ORGANIZATION_PRODUCTION_BUCKET_ID,
      providerSyncState: "synced", kind: "organizational", visibility: "members", organizationId: memberOrganizationId,
      createdBy: `fixture:${tag}`, updatedBy: `fixture:${tag}`, createdAt: now, updatedAt: now,
    });
    const memberOrganizationProfileId = await ctx.db.insert("organizationalJurisdictions", {
      jurisdictionId: jurisdictionMemberOnlyId, scopeMode: "linked_geographies", createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("organizationGeographicScopes", {
      organizationalJurisdictionId: memberOrganizationProfileId, geographicJurisdictionId: townProfileId, createdAt: now,
    });
    const jurisdictionMemberId = await ctx.db.insert("organizationMemberships", {
      organizationId: memberOrganizationId, userId: member.userId, status: "active", createdAt: now, updatedAt: now,
    });
    const jurisdictionFormerMemberId = await ctx.db.insert("organizationMemberships", {
      organizationId: memberOrganizationId, userId: formerMember.userId, status: "inactive", createdAt: now, updatedAt: now,
    });

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

    await ctx.db.patch(runId, { state: "ready", updatedAt: Date.now() });
    return {
      tag, providerTransport: "stub" as const, deployedCommitSha, billingDisabled: true as const, sessions,
      variants: { normal, noTwoFactor, unassured },
      jurisdictionUsers: { member, formerMember },
      records: {
        chatId, resourceId, publishedVersionId, reviewVersionId, separationVersionId, conversationGrantId, jurisdictionId, userId: normal.userId,
        stagingBucketId: FIXTURE_STAGING_BUCKET_ID, productionBucketId: FIXTURE_PRODUCTION_BUCKET_ID, callbackToken, callbackJobId,
        usageUserId: `fixture:${tag}`,
        jurisdictionCountryId, jurisdictionTownId, publicOrganizationJurisdictionId, jurisdictionMemberOnlyId,
        jurisdictionMemberId, jurisdictionFormerMemberId,
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
        deployedCommitSha: string;
        billingDisabled: true;
        sessions: Record<(typeof FIXED_ROLES)[number], { userId: string; sessionToken: string }>;
        variants: Record<"normal" | "noTwoFactor" | "unassured", { userId: string; sessionToken: string }>;
        jurisdictionUsers: Record<"member" | "formerMember", { userId: string; sessionToken: string }>;
        records: {
          chatId: Id<"chatSessions">; resourceId: Id<"legalResources">; publishedVersionId: Id<"documentVersions">;
          reviewVersionId: Id<"documentVersions">; separationVersionId: Id<"documentVersions">; conversationGrantId: Id<"adminAccessGrants">; jurisdictionId: Id<"jurisdictions">;
          userId: string; stagingBucketId: string; productionBucketId: string;
          callbackToken: string; callbackJobId: Id<"integrationJobs">; usageUserId: string;
          jurisdictionCountryId: Id<"jurisdictions">; jurisdictionTownId: Id<"jurisdictions">;
          publicOrganizationJurisdictionId: Id<"jurisdictions">; jurisdictionMemberOnlyId: Id<"jurisdictions">;
          jurisdictionMemberId: Id<"organizationMemberships">; jurisdictionFormerMemberId: Id<"organizationMemberships">;
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
  returns: v.object({ tag: v.string(), deleted: v.number(), cleanupConflict: v.boolean() }),
  handler: async (ctx, { tag }) => {
    requireFixtureEnvironment(); requireTag(tag);
    const environment = process.env.ADMIN_E2E_TARGET_ENV as "test" | "preview";
    const [tagRuns, environmentRuns] = await Promise.all([
      ctx.db.query("e2eFixtureRuns").withIndex("by_tag", (q) => q.eq("tag", tag)).take(2),
      ctx.db.query("e2eFixtureRuns").withIndex("by_environment", (q) => q.eq("environment", environment)).take(2),
    ]);
    if (tagRuns.length > 1 || environmentRuns.length > 1) throw new ConvexError("E2E_FIXTURE_RUN_STATE_INVALID");
    const run = tagRuns[0];
    if (!run) return { tag, deleted: await cleanupFixture(ctx, tag), cleanupConflict: false };
    if (run.environment !== environment || environmentRuns[0]?._id !== run._id) {
      await ctx.db.patch(run._id, { state: "cleanup_conflict", updatedAt: Date.now() });
      return { tag, deleted: 0, cleanupConflict: true };
    }
    const currentFlag = await ctx.db.get(run.fixtureFlagWrite.rowId);
    const expected = run.fixtureFlagWrite;
    if (!currentFlag
      || currentFlag.key !== "unified_jurisdictions"
      || currentFlag.environment !== environment
      || currentFlag.enabled !== expected.enabled
      || currentFlag.updatedAt !== expected.updatedAt
      || currentFlag.updatedBy !== expected.updatedBy) {
      await ctx.db.patch(run._id, { state: "cleanup_conflict", updatedAt: Date.now() });
      return { tag, deleted: 0, cleanupConflict: true };
    }
    const ownership = await ctx.db.query("e2eFixtureOwnership")
      .withIndex("by_tag_and_kind", (q) => q.eq("tag", tag))
      .take(501);
    if (ownership.length > 500) {
      await ctx.db.patch(run._id, { state: "cleanup_conflict", updatedAt: Date.now() });
      return { tag, deleted: 0, cleanupConflict: true };
    }
    const ownedUserIds = ownership.filter((row) => row.kind === "better_auth_user").map((row) => row.targetId);
    await ctx.db.patch(run._id, { state: "cleaning", updatedAt: Date.now() });
    let deleted = await cleanupFixture(ctx, tag, { deleteOwnership: false });
    const residualDeleted = await cleanupFixture(ctx, tag, { deleteOwnership: false });
    deleted += residualDeleted;
    let fixtureUserDependencyStillExists = false;
    for (const userId of ownedUserIds) {
      for (const model of ["session", "account", "twoFactor", "user"] as const) {
        const result = await ctx.runQuery(components.betterAuth.adapter.findMany, {
          model,
          where: [{ field: model === "user" ? "_id" : "userId", operator: "eq", value: userId }],
          select: ["id"],
          paginationOpts: { numItems: 1, cursor: null },
        }) as { page: Array<{ _id: string }> };
        if (result.page.length !== 0) fixtureUserDependencyStillExists = true;
      }
    }
    if (residualDeleted !== 0 || fixtureUserDependencyStillExists || await globalCleanupBoundsExceeded(ctx)) {
      await ctx.db.patch(run._id, { state: "cleanup_conflict", updatedAt: Date.now() });
      return { tag, deleted, cleanupConflict: true };
    }
    if (run.priorFlag.kind === "absent") {
      await ctx.db.delete(currentFlag._id);
    } else {
      if (run.priorFlag.rowId !== currentFlag._id) throw new ConvexError("E2E_FIXTURE_FLAG_STATE_INVALID");
      await ctx.db.replace(currentFlag._id, {
        key: "unified_jurisdictions",
        environment,
        enabled: run.priorFlag.enabled,
        updatedAt: run.priorFlag.updatedAt,
        ...(run.priorFlag.updatedBy !== undefined ? { updatedBy: run.priorFlag.updatedBy } : {}),
      });
    }
    const restoredFlags = await ctx.db.query("featureFlags")
      .withIndex("by_key_and_environment", (q) => q.eq("key", "unified_jurisdictions").eq("environment", environment))
      .take(2);
    const exactFlagRestored = run.priorFlag.kind === "absent"
      ? restoredFlags.length === 0
      : restoredFlags.length === 1
        && restoredFlags[0]._id === run.priorFlag.rowId
        && restoredFlags[0].enabled === run.priorFlag.enabled
        && restoredFlags[0].updatedAt === run.priorFlag.updatedAt
        && restoredFlags[0].updatedBy === run.priorFlag.updatedBy;
    if (!exactFlagRestored) {
      await ctx.db.patch(run._id, { state: "cleanup_conflict", updatedAt: Date.now() });
      return { tag, deleted, cleanupConflict: true };
    }
    for (const row of ownership) { await ctx.db.delete(row._id); deleted += 1; }
    const residualOwnership = await ctx.db.query("e2eFixtureOwnership")
      .withIndex("by_tag_and_kind", (q) => q.eq("tag", tag))
      .take(1);
    if (residualOwnership.length !== 0) {
      await ctx.db.patch(run._id, { state: "cleanup_conflict", updatedAt: Date.now() });
      return { tag, deleted, cleanupConflict: true };
    }
    await ctx.db.delete(run._id);
    return { tag, deleted, cleanupConflict: false };
  },
});

const matrixRoleValidator = v.union(...FIXED_ROLES.map((role) => v.literal(role)));
const MATRIX_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

function matrixJurisdictionCode(path: string, role: (typeof FIXED_ROLES)[number]) {
  const pathIndex = E2E_PRIVILEGED_FUNCTIONS.findIndex((entry) => entry.path === path);
  const roleIndex = FIXED_ROLES.indexOf(role);
  if (pathIndex < 0 || roleIndex < 0) throw new ConvexError("E2E_MATRIX_ENTRY_NOT_FOUND");
  const ordinal = pathIndex * FIXED_ROLES.length + roleIndex;
  return `${String.fromCharCode(65 + Math.floor(ordinal / 26))}${String.fromCharCode(65 + (ordinal % 26))}`;
}

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
  await ctx.db.insert("e2eFixtureOwnership", { tag, kind: "better_auth_user", targetId: user._id, createdAt: now });
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

async function recordFixtureOwnership(
  ctx: MutationCtx,
  tag: string,
  kind: Doc<"e2eFixtureOwnership">["kind"],
  targetId: string,
) {
  await ctx.db.insert("e2eFixtureOwnership", { tag, kind, targetId, createdAt: Date.now() });
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

type StubPublicationOperation = "publish" | "rollback" | "unpublish";
type StubProviderOutcome = "succeeded" | "failed";

function publicationOperationFromPayload(payload: string): StubPublicationOperation | null {
  let value: unknown;
  try { value = JSON.parse(payload); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const operation = (value as { operation?: unknown }).operation;
  return operation === "publish" || operation === "rollback" || operation === "unpublish" ? operation : null;
}

async function requireTaggedVersion(ctx: MutationCtx, tag: string, versionId: Id<"documentVersions">) {
  const version = await ctx.db.get(versionId);
  if (!version) throw new ConvexError("E2E_FIXTURE_VERSION_MISMATCH");
  const resource = await ctx.db.get(version.resourceId);
  if (!resource) throw new ConvexError("E2E_FIXTURE_VERSION_MISMATCH");
  const jurisdiction = await ctx.db.get(resource.jurisdictionId);
  if (!jurisdiction || (jurisdiction.slug !== tag && jurisdiction.createdBy !== `fixture:${tag}`)) {
    throw new ConvexError("E2E_FIXTURE_VERSION_MISMATCH");
  }
  return { version, resource };
}

async function armProviderOutcome(
  ctx: MutationCtx,
  input: { tag: string; versionId: Id<"documentVersions">; operation: StubPublicationOperation; outcome: StubProviderOutcome },
) {
  await requireTaggedVersion(ctx, input.tag, input.versionId);
  const rows = await ctx.db.query("e2eProviderStubOutcomes")
    .withIndex("by_targetId_and_operation", (q) => q.eq("targetId", input.versionId).eq("operation", input.operation))
    .take(2);
  if (rows.length > 1) throw new ConvexError("E2E_PROVIDER_OUTCOME_STATE_INVALID");
  const existing = rows[0];
  if (existing && existing.tag !== input.tag) throw new ConvexError("E2E_PROVIDER_OUTCOME_TAG_MISMATCH");
  if (existing && existing.consumedAt === undefined) throw new ConvexError("E2E_PROVIDER_OUTCOME_ALREADY_ARMED");
  const state = { tag: input.tag, targetId: input.versionId, operation: input.operation, outcome: input.outcome, armedAt: Date.now(), consumedAt: undefined, jobId: undefined };
  if (existing) await ctx.db.patch(existing._id, state);
  else await ctx.db.insert("e2eProviderStubOutcomes", state);
  return { armed: true as const, tag: input.tag, versionId: input.versionId, operation: input.operation, outcome: input.outcome };
}

export const consumeProviderOutcome = internalMutation({
  args: { jobId: v.id("integrationJobs") },
  returns: v.union(v.literal("succeeded"), v.literal("failed")),
  handler: async (ctx, args) => {
    requireFixtureEnvironment();
    const job = await ctx.db.get(args.jobId);
    if (!job || job.status !== "running") throw new ConvexError("E2E_PROVIDER_JOB_STATE_INVALID");
    const operation = publicationOperationFromPayload(job.payload);
    if (job.targetType !== "documentVersion" || operation === null) return "succeeded" as const;
    const rows = await ctx.db.query("e2eProviderStubOutcomes")
      .withIndex("by_targetId_and_operation", (q) => q.eq("targetId", job.targetId).eq("operation", operation))
      .take(2);
    if (rows.length !== 1 || rows[0].consumedAt !== undefined || rows[0].jobId !== undefined) {
      throw new ConvexError("E2E_PROVIDER_OUTCOME_NOT_ARMED");
    }
    await requireTaggedVersion(ctx, rows[0].tag, job.targetId as Id<"documentVersions">);
    await ctx.db.patch(rows[0]._id, { consumedAt: Date.now(), jobId: job._id });
    return rows[0].outcome;
  },
});

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
    case "admin/featureFlags:setAdminPanel": {
      const environment = process.env.ADMIN_E2E_TARGET_ENV!;
      await insertStepUp(ctx, actor, "admin_panel_set", `admin_panel:${environment}`, input.key);
      Object.assign(args, {
        environment,
        enabled: true,
        confirmation: `ADMIN_PANEL ${environment} ENABLE`,
        reason,
        idempotencyKey: input.key,
      });
      break;
    }
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
    case "admin/resources:createJurisdiction": Object.assign(args, { code: matrixJurisdictionCode(input.path, input.role), name: `${marker} jurisdiction`, slug: `m-${crypto.randomUUID().slice(0, 12)}`, stagingBucketId: FIXTURE_STAGING_BUCKET_ID, productionBucketId: FIXTURE_PRODUCTION_BUCKET_ID, isDefault: false, reason }); break;
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
    case "admin/publication:rollbackVersion": { const operation = input.path.includes("unpublish") ? "unpublish" : input.path.includes("rollback") ? "rollback" : "publish"; const status = operation === "publish" ? "approved" : operation === "unpublish" ? "published" : "superseded"; const item = await createMatrixVersion(ctx, input.tag, input.key, operation, status, actor.userId); if (operation === "rollback") { const { storageId } = await mainFixtureRecords(ctx, input.tag); const activeId = await ctx.db.insert("documentVersions", { resourceId: item.resourceId, versionNumber: 2, originalStorageId: storageId, filename: `${marker}-active.pdf`, mimeType: "application/pdf", byteSize: 18, sha256: "f".repeat(64), sourceUrl: "https://example.invalid/active", effectiveDate: "2026-03-01", status: "published", groundxStagingDocumentId: `${marker}-active-stage`, groundxProductionDocumentId: `${marker}-active-prod`, submittedBy: actor.userId, submittedAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() }); await ctx.db.patch(item.resourceId, { activeVersionId: activeId }); } await armProviderOutcome(ctx, { tag: input.tag, versionId: item.versionId, operation, outcome: "succeeded" }); await insertStepUp(ctx, actor, `document_${operation}`, item.versionId, input.key); Object.assign(args, { versionId: item.versionId, confirmation: `${operation.toUpperCase()} ${item.versionId}`, reason, idempotencyKey: input.key }); break; }
    case "admin/billing:grantQuotaOverride": {
      const target = await user("quota_grant");
      Object.assign(args, { userId: target.userId, limit: 25, startsAt: Date.now(), expiresAt: Date.now() + 60_000, reason, confirmation: "", idempotencyKey: input.key });
      break;
    }
    case "admin/billing:revokeQuotaOverride": {
      const target = await user("quota_revoke");
      const operationId = await ctx.db.insert("adminOperations", { actorId: `fixture:${input.tag}`, action: "e2e.fixture", targetId: input.tag, idempotencyKey: `${input.key}.grant`, requestFingerprint: "{}", correlationId: `${marker}-grant`, status: "succeeded", createdAt: Date.now(), updatedAt: Date.now() });
      await recordFixtureOwnership(ctx, input.tag, "admin_operation", operationId);
      const overrideId = await ctx.db.insert("quotaOverrides", { userId: target.userId, limit: 25, startsAt: Date.now(), expiresAt: Date.now() + 60_000, grantedBy: `fixture:${input.tag}`, reason, active: true, grantOperationId: operationId, createdAt: Date.now(), updatedAt: Date.now() });
      await recordFixtureOwnership(ctx, input.tag, "quota_override", overrideId);
      Object.assign(args, { overrideId, reason, idempotencyKey: input.key });
      break;
    }
    case "admin/jobs:enqueueJob": Object.assign(args, { type: "poll_process", targetType: "e2e_fixture", targetId: marker, payload: { processId: `${marker}-process` }, idempotencyKey: input.key }); break;
    case "admin/jobs:retryJob":
    case "admin/jobs:cancelJob": { const retry = input.path.endsWith("retryJob"); const jobId = await ctx.db.insert("integrationJobs", { type: "poll_process", targetType: "e2e_fixture", targetId: marker, payload: JSON.stringify({ processId: `${marker}-process` }), actorId: actor.userId, actorRoles: [input.role], idempotencyKey: `${input.key}.seed`, requestFingerprint: "{}", correlationId: `${marker}-seed`, callbackTokenHash: "0".repeat(64), status: retry ? "failed" : "queued", attemptCount: retry ? 1 : 0, ...(retry ? { lastErrorKind: "network" as const } : { nextAttemptAt: Date.now() }), createdAt: Date.now(), updatedAt: Date.now() }); Object.assign(args, { jobId, reason, idempotencyKey: input.key }); break; }
    case "admin/operations:createIncident": Object.assign(args, { title: `${marker} incident`, severity: "low", reason, idempotencyKey: input.key }); break;
    case "admin/operations:addIncidentNote":
    case "admin/operations:updateIncident": {
      const incidentId = await ctx.db.insert("systemIncidents", { title: `${marker} incident`, severity: "low", status: "open", createdBy: `fixture:${input.tag}`, createdAt: Date.now(), updatedAt: Date.now() });
      await recordFixtureOwnership(ctx, input.tag, "system_incident", incidentId);
      Object.assign(args, input.path.endsWith("addIncidentNote") ? { incidentId, note: "Tagged fixture incident note", reason, idempotencyKey: input.key } : { incidentId, status: "investigating", severity: "medium", ownerId: actor.userId, reason, idempotencyKey: input.key });
      break;
    }
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

  if (input.path === "admin/featureFlags:setAdminPanel") {
    const rows = await ctx.db.query("featureFlags").withIndex("by_key_and_environment", (q) =>
      q.eq("key", "admin_panel").eq("environment", String(args.environment)),
    ).take(2);
    const audits = await ctx.db.query("auditEvents").withIndex("by_actorId_and_createdAt", (q) =>
      q.eq("actorId", actor.userId),
    ).order("desc").take(10);
    terminal = rows.length === 1 && rows[0].enabled === args.enabled && operation?.status === "succeeded" && proofs[0]?.consumedAt !== undefined && audits.some((row) => row.action === "admin.panel_flag_set" && row.outcome === "success");
    state = { enabled: rows[0]?.enabled ?? null, operationStatus: operation?.status ?? null, proofConsumed: proofs[0]?.consumedAt !== undefined, audited: audits.some((row) => row.action === "admin.panel_flag_set" && row.outcome === "success") };
  } else if (input.path === "admin/roles:setAdminRoles" || input.path === "admin/users:assignRoles") {
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
  v.literal("arm_provider_outcome"),
  v.literal("expire_conversation_grant"),
  v.literal("read_state"),
  v.literal("run_retention"),
  v.literal("prepare_matrix_operation"),
  v.literal("read_matrix_operation"),
  v.literal("deactivate_jurisdiction_member"),
  v.literal("set_unified_jurisdictions_flag"),
);

async function ownedReadyRun(ctx: MutationCtx, tag: string) {
  const environment = process.env.ADMIN_E2E_TARGET_ENV as "test" | "preview";
  const [tagRuns, environmentRuns] = await Promise.all([
    ctx.db.query("e2eFixtureRuns").withIndex("by_tag", (q) => q.eq("tag", tag)).take(2),
    ctx.db.query("e2eFixtureRuns").withIndex("by_environment", (q) => q.eq("environment", environment)).take(2),
  ]);
  if (tagRuns.length !== 1 || environmentRuns.length !== 1
    || tagRuns[0]._id !== environmentRuns[0]._id
    || tagRuns[0].state !== "ready") {
    throw new ConvexError("E2E_FIXTURE_RUN_NOT_READY");
  }
  return tagRuns[0];
}

export const applyControl = internalMutation({
  args: {
    tag: v.string(), operation: controlOperationValidator, versionId: v.optional(v.id("documentVersions")),
    publicationOperation: v.optional(v.union(v.literal("publish"), v.literal("rollback"), v.literal("unpublish"))),
    providerOutcome: v.optional(v.union(v.literal("succeeded"), v.literal("failed"))),
    membershipId: v.optional(v.id("organizationMemberships")),
    enabled: v.optional(v.boolean()),
    path: v.optional(v.string()), role: v.optional(matrixRoleValidator), key: v.optional(v.string()), payload: v.optional(v.any()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireFixtureEnvironment(); requireTag(args.tag);
    if (args.operation === "deactivate_jurisdiction_member") {
      if (!args.membershipId) throw new ConvexError("E2E_MEMBERSHIP_ARGUMENT_REQUIRED");
      await ownedReadyRun(ctx, args.tag);
      const membership = await ctx.db.get(args.membershipId);
      if (!membership || membership.status !== "active") throw new ConvexError("E2E_FIXTURE_MEMBERSHIP_MISMATCH");
      const [organization, users] = await Promise.all([
        ctx.db.get(membership.organizationId),
        listFixtureUsers(ctx, args.tag),
      ]);
      const member = users.find((user) => user.email === `member.${args.tag}@e2e.invalid`);
      const jurisdictions = organization
        ? await ctx.db.query("jurisdictions").withIndex("by_organizationId", (q) => q.eq("organizationId", organization._id)).take(2)
        : [];
      if (!organization
        || organization.createdBy !== `fixture:${args.tag}`
        || membership.userId !== member?.userId
        || jurisdictions.length !== 1
        || jurisdictions[0].visibility !== "members"
        || jurisdictions[0].createdBy !== `fixture:${args.tag}`) {
        throw new ConvexError("E2E_FIXTURE_MEMBERSHIP_MISMATCH");
      }
      await ctx.db.patch(membership._id, { status: "inactive", updatedAt: Date.now() });
      return { membershipId: membership._id, active: false as const };
    }
    if (args.operation === "set_unified_jurisdictions_flag") {
      if (args.enabled === undefined) throw new ConvexError("E2E_FLAG_ARGUMENT_REQUIRED");
      const run = await ownedReadyRun(ctx, args.tag);
      const flag = await ctx.db.get(run.fixtureFlagWrite.rowId);
      const expected = run.fixtureFlagWrite;
      if (!flag
        || flag.key !== "unified_jurisdictions"
        || flag.environment !== run.environment
        || flag.enabled !== expected.enabled
        || flag.updatedAt !== expected.updatedAt
        || flag.updatedBy !== expected.updatedBy) {
        await ctx.db.patch(run._id, { state: "cleanup_conflict", updatedAt: Date.now() });
        return { enabled: expected.enabled, cleanupConflict: true as const };
      }
      const fixtureFlagWrite = {
        rowId: flag._id,
        enabled: args.enabled,
        updatedAt: Math.max(Date.now(), flag.updatedAt + 1),
        updatedBy: `fixture:${args.tag}`,
      };
      await ctx.db.patch(flag._id, {
        enabled: fixtureFlagWrite.enabled,
        updatedAt: fixtureFlagWrite.updatedAt,
        updatedBy: fixtureFlagWrite.updatedBy,
      });
      await ctx.db.patch(run._id, { fixtureFlagWrite, updatedAt: fixtureFlagWrite.updatedAt });
      return { enabled: args.enabled, cleanupConflict: false as const };
    }
    if (args.operation === "prepare_matrix_operation") {
      if (!args.path || !args.role || !args.key) throw new ConvexError("E2E_MATRIX_ARGUMENTS_REQUIRED");
      return await prepareMatrixOperation(ctx, { tag: args.tag, path: args.path, role: args.role, key: args.key });
    }
    if (args.operation === "read_matrix_operation") {
      if (!args.path || !args.role || !args.key) throw new ConvexError("E2E_MATRIX_ARGUMENTS_REQUIRED");
      return await readMatrixOperation(ctx, { tag: args.tag, path: args.path, role: args.role, key: args.key, payload: args.payload });
    }
    if (args.operation === "arm_provider_outcome") {
      if (!args.versionId || !args.publicationOperation || !args.providerOutcome) {
        throw new ConvexError("E2E_PROVIDER_OUTCOME_ARGUMENTS_REQUIRED");
      }
      return await armProviderOutcome(ctx, {
        tag: args.tag,
        versionId: args.versionId,
        operation: args.publicationOperation,
        outcome: args.providerOutcome,
      });
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
    }

    const versions = await ctx.db.query("documentVersions")
      .withIndex("by_resourceId_and_versionNumber", (q) => q.eq("resourceId", resource._id)).take(10);
    const chat = await ctx.db.query("chatSessions")
      .withIndex("by_user_externalId", (q) => q.eq("userId", `fixture:${args.tag}`).eq("externalId", args.tag)).unique();
    const grants = chat ? await ctx.db.query("adminAccessGrants").withIndex("by_expiresAt").take(500) : [];
    const callbackJob = await ctx.db.query("integrationJobs")
      .withIndex("by_targetType_and_targetId", (q) => q.eq("targetType", "e2e_fixture").eq("targetId", args.tag)).unique();
    const publicationJobs = args.versionId
      ? await ctx.db.query("integrationJobs").withIndex("by_targetType_and_targetId", (q) => q.eq("targetType", "documentVersion").eq("targetId", args.versionId!)).take(20)
      : [];
    const latestPublicationJob = publicationJobs.sort((left, right) => right.createdAt - left.createdAt)[0];
    return {
      activeVersionId: resource.activeVersionId ?? null,
      versions: versions.map((row) => ({ id: row._id, versionNumber: row.versionNumber, status: row.status, failureSummary: row.failureSummary ?? null })),
      grantActive: grants.some((row) => row.chatSessionId === chat?._id && row.correlationId === `${args.tag}-grant` && row.expiresAt > Date.now() && row.revokedAt === undefined),
      retention: { deletedTotal: callbackJob?.retentionRedactedAt ? 1 : 0, lastSuccessfulAt: callbackJob?.retentionRedactedAt ?? null },
      callbackJob: callbackJob ? { status: callbackJob.status, payload: callbackJob.payload, retentionRedactedAt: callbackJob.retentionRedactedAt ?? null } : null,
      publicationJob: latestPublicationJob ? { id: latestPublicationJob._id, status: latestPublicationJob.status, processId: latestPublicationJob.processId ?? null, lastErrorKind: latestPublicationJob.lastErrorKind ?? null } : null,
    };
  },
});

const applyControlRef = makeFunctionReference<"mutation">("admin/e2eFixtures:applyControl");
export const control = internalAction({
  args: {
    tag: v.string(),
    operation: v.union(controlOperationValidator, v.literal("run_retention")),
    versionId: v.optional(v.id("documentVersions")),
    publicationOperation: v.optional(v.union(v.literal("publish"), v.literal("rollback"), v.literal("unpublish"))),
    providerOutcome: v.optional(v.union(v.literal("succeeded"), v.literal("failed"))),
    membershipId: v.optional(v.id("organizationMemberships")),
    enabled: v.optional(v.boolean()),
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
