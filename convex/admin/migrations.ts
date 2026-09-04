import { ConvexError, v } from "convex/values";
import { components } from "../_generated/api";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { authComponent } from "../auth";
import { parseAdminRoles } from "../lib/adminPermissions";
import { writeAdminRoles } from "./roles";
import { appendAuditEvent } from "../lib/audit";
import type { Doc, Id } from "../_generated/dataModel";
import { resolveLegacyJurisdictionSnapshot } from "../lib/legacyJurisdictionCompatibility";
import {
  JURISDICTION_MIGRATION_VERSION,
  JURISDICTION_MIGRATION_IDEMPOTENCY_KEY,
  assertMigrationCheckpointState,
  ghanaProjectionFingerprint,
  jurisdictionMigrationTargetValidator,
  migrationPageResultValidator,
  readRolloutStateRow,
  requireMigrationEnvironment,
  type JurisdictionMigrationTarget,
  type MigrationPageResult,
} from "../lib/unifiedJurisdictionRollout";
import { validateAuditReason, writeAudit } from "./audit";
import { isLegacyCountryCode } from "../lib/jurisdictionDomain";

const authTableCountsValidator = v.object({
  user: v.number(),
  session: v.number(),
  account: v.number(),
  verification: v.number(),
});

const authMigrationSnapshotValidator = v.object({
  component: v.string(),
  counts: authTableCountsValidator,
});

export type AuthTableCounts = {
  user: number;
  session: number;
  account: number;
  verification: number;
};

export type AuthMigrationSnapshot = {
  component: string;
  counts: AuthTableCounts;
};

const authTables = ["user", "session", "account", "verification"] as const;

const MAX_INITIAL_SUPER_ADMINS = 100;
const GHANA_MIGRATION_ACTOR = "migration:seed-ghana-jurisdiction-v1";
const GHANA_V2_MIGRATION_ACTOR = "migration:seed-ghana-jurisdiction-v2";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
type MigrationRow =
  { target: "chatSessions"; row: Doc<"chatSessions"> };

type MigrationClassification = {
  status: "clean" | "update" | "unresolved" | "mismatch";
  patch?: {
    jurisdictionId?: Id<"jurisdictions">;
    jurisdictionName?: string;
    jurisdictionKind?: "geographic" | "organizational";
    jurisdictionContract?: "legacy";
  };
};

type MigrationLookupCache = {
  byId: Map<
    Id<"jurisdictions">,
    Promise<Doc<"jurisdictions"> | null>
  >;
  byLegacyCode: Map<
    string,
    ReturnType<typeof resolveLegacyJurisdictionSnapshot>
  >;
};

function assertMigrationIdempotencyKey(value: string): void {
  if (!JURISDICTION_MIGRATION_IDEMPOTENCY_KEY.test(value)) {
    throw new ConvexError("JURISDICTION_MIGRATION_IDEMPOTENCY_KEY_INVALID");
  }
}

function canonicalJson(value: Record<string, string | number>): string {
  return JSON.stringify(value);
}

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeGhanaProjection(place: {
  googlePlaceId: string;
  formattedAddress: string;
  latitude: number;
  longitude: number;
}) {
  const googlePlaceId = place.googlePlaceId.trim();
  const formattedAddress = place.formattedAddress.trim();
  if (!googlePlaceId || googlePlaceId.length > 255 ||
      !formattedAddress || formattedAddress.length > 500 ||
      CONTROL_CHARACTERS.test(formattedAddress) ||
      !Number.isFinite(place.latitude) || place.latitude < -90 || place.latitude > 90 ||
      !Number.isFinite(place.longitude) || place.longitude < -180 || place.longitude > 180) {
    throw new ConvexError("GHANA_SEED_V2_PROJECTION_INVALID");
  }
  return {
    googlePlaceId,
    formattedAddress,
    latitude: place.latitude,
    longitude: place.longitude,
    level: "country" as const,
    countryCode: "GH" as const,
  };
}

async function writeSystemMigrationAudit(
  ctx: MutationCtx,
  input: {
    action: string;
    targetId: string;
    reason: string;
    correlationId: string;
    metadata: Record<string, string | number | boolean | null>;
  },
) {
  await writeAudit(
    ctx,
    {
      actorId: "system",
      actorRoles: [],
      action: input.action,
      targetType: "jurisdictionMigration",
      targetId: input.targetId,
      reason: input.reason,
      correlationId: input.correlationId,
      outcome: "success",
    },
    { actorType: "system", metadata: input.metadata },
  );
}

async function assertGhanaSeedConflicts(
  ctx: MutationCtx,
  existingId?: Id<"jurisdictions">,
) {
  const [draftDefaults, enabledDefaults] = await Promise.all([
    ctx.db
      .query("jurisdictions")
      .withIndex("by_isDefault_and_status", (q) =>
        q.eq("isDefault", true).eq("status", "draft"),
      )
      .take(2),
    ctx.db
      .query("jurisdictions")
      .withIndex("by_isDefault_and_status", (q) =>
        q.eq("isDefault", true).eq("status", "enabled"),
      )
      .take(2),
  ]);
  if (
    [...draftDefaults, ...enabledDefaults].some(
      (row) => row._id !== existingId && row.status !== "archived",
    )
  ) {
    throw new ConvexError("GHANA_SEED_DEFAULT_CONFLICT");
  }
}

export function parseInitialSuperAdminIds(value: string | undefined): string[] {
  const userIds = [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((userId) => userId.trim())
        .filter(Boolean),
    ),
  ];

  if (userIds.length > MAX_INITIAL_SUPER_ADMINS) {
    throw new Error(
      `INITIAL_SUPER_ADMIN_IDS cannot contain more than ${MAX_INITIAL_SUPER_ADMINS} users`,
    );
  }

  return userIds;
}

export function verifyAuthMigrationSnapshot(
  before: AuthMigrationSnapshot,
  after: AuthMigrationSnapshot,
): AuthMigrationSnapshot {
  if (before.component !== "betterAuth" || after.component !== "betterAuth") {
    throw new Error(
      `Better Auth component identity changed: ${before.component} -> ${after.component}`,
    );
  }

  for (const table of authTables) {
    if (before.counts[table] !== after.counts[table]) {
      throw new Error(
        `Better Auth component data changed: ${table} ${before.counts[table]} -> ${after.counts[table]}`,
      );
    }
  }

  return after;
}

async function readAuthMigrationSnapshot(
  ctx: QueryCtx,
): Promise<AuthMigrationSnapshot> {
  const counts: AuthTableCounts = await ctx.runQuery(
    components.betterAuth.migrations.countAuthTables,
    {},
  );

  return { component: "betterAuth", counts };
}

export const captureAuthMigrationSnapshot = internalQuery({
  args: {},
  returns: authMigrationSnapshotValidator,
  handler: readAuthMigrationSnapshot,
});

export const assertAuthMigrationSnapshot = internalQuery({
  args: { before: authMigrationSnapshotValidator },
  returns: authMigrationSnapshotValidator,
  handler: async (ctx, args) =>
    verifyAuthMigrationSnapshot(
      args.before,
      await readAuthMigrationSnapshot(ctx),
    ),
});

/**
 * Internal-only rollout gate for public Ghana search. Operators must run this
 * successfully before deploying the route that consumes governed buckets.
 */
export const seedGhanaJurisdiction = internalMutation({
  args: {},
  returns: v.object({
    jurisdictionId: v.id("jurisdictions"),
    changed: v.boolean(),
    created: v.boolean(),
  }),
  handler: async (ctx) => {
    const existingRows = await ctx.db
      .query("jurisdictions")
      .withIndex("by_code", (q) => q.eq("code", "GH"))
      .take(2);
    if (existingRows.length > 1) {
      throw new ConvexError("GHANA_SEED_CODE_CONFLICT");
    }
    const existing = existingRows[0];
    await assertGhanaSeedConflicts(ctx, existing?._id);

    if (!existing) {
      const slugRows = await ctx.db
        .query("jurisdictions")
        .withIndex("by_slug", (q) => q.eq("slug", "ghana"))
        .take(2);
      if (slugRows.length > 0) {
        throw new ConvexError("GHANA_SEED_SLUG_CONFLICT");
      }
    }

    const alreadyGoverned =
      existing?.status === "draft" &&
      existing.isDefault === true &&
      existing.providerSyncState === "pending";
    if (existing && alreadyGoverned) {
      return {
        jurisdictionId: existing._id,
        changed: false,
        created: false,
      };
    }

    const now = Date.now();
    const jurisdictionId = existing
      ? existing._id
      : await ctx.db.insert("jurisdictions", {
          code: "GH",
          name: "Ghana",
          slug: "ghana",
          status: "draft",
          isDefault: true,
          providerSyncState: "pending",
          createdBy: GHANA_MIGRATION_ACTOR,
          updatedBy: GHANA_MIGRATION_ACTOR,
          createdAt: now,
          updatedAt: now,
        });

    if (existing) {
      await ctx.db.patch("jurisdictions", existing._id, {
        status: "draft",
        isDefault: true,
        providerSyncState: "pending",
        updatedBy: GHANA_MIGRATION_ACTOR,
        updatedAt: now,
      });
    }

    await appendAuditEvent(ctx, {
      actorType: "system",
      action: "migration.seed_ghana_jurisdiction",
      targetType: "jurisdiction",
      targetId: jurisdictionId,
      metadata: {
        migration: "seed-ghana-jurisdiction-v1",
        result: existing ? "updated" : "created",
      },
    });

    return {
      jurisdictionId,
      changed: true,
      created: existing === undefined,
    };
  },
});

export const seedGhanaJurisdictionV2 = internalMutation({
  args: {
    environment: v.string(),
    place: v.object({
      googlePlaceId: v.string(),
      formattedAddress: v.string(),
      latitude: v.number(),
      longitude: v.number(),
    }),
    confirmation: v.string(),
    reason: v.string(),
    idempotencyKey: v.string(),
  },
  returns: v.object({
    jurisdictionId: v.id("jurisdictions"),
    changed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const environment = requireMigrationEnvironment(args.environment);
    if (args.confirmation !== `SEED_GHANA_JURISDICTION_V2 ${environment}`) {
      throw new ConvexError("JURISDICTION_MIGRATION_CONFIRMATION_MISMATCH");
    }
    assertMigrationIdempotencyKey(args.idempotencyKey);
    const reason = validateAuditReason(args.reason);
    const place = normalizeGhanaProjection(args.place);
    const fingerprint = await ghanaProjectionFingerprint(place);
    const requestFingerprint = await sha256(
      canonicalJson({
        version: "ghana_seed_request_v1",
        environment,
        projectionFingerprint: fingerprint,
        reason,
      }),
    );
    const rollout = await readRolloutStateRow(ctx, environment);
    if (rollout?.ghanaSeedLastIdempotencyKey === args.idempotencyKey) {
      if (rollout.ghanaSeedLastRequestFingerprint !== requestFingerprint) {
        throw new ConvexError("JURISDICTION_MIGRATION_IDEMPOTENCY_CONFLICT");
      }
      if (!rollout.ghanaSeedLastResult ||
          rollout.ghanaJurisdictionId !== rollout.ghanaSeedLastResult.jurisdictionId ||
          rollout.ghanaProjectionFingerprint !== fingerprint) {
        throw new ConvexError("JURISDICTION_MIGRATION_STATE_INVALID");
      }
      return {
        jurisdictionId: rollout.ghanaSeedLastResult.jurisdictionId,
        changed: rollout.ghanaSeedLastResult.changed,
      };
    }

    const ghanaRows = await ctx.db
      .query("jurisdictions")
      .withIndex("by_code", (q) => q.eq("code", "GH"))
      .take(2);
    if (ghanaRows.length === 0) throw new ConvexError("GHANA_SEED_V2_NOT_FOUND");
    if (ghanaRows.length !== 1) throw new ConvexError("GHANA_SEED_V2_CODE_CONFLICT");
    const ghana = ghanaRows[0];
    if ((ghana.kind !== undefined && ghana.kind !== "geographic") ||
        (ghana.visibility !== undefined && ghana.visibility !== "public") ||
        (ghana.legacyCountryCode !== undefined && ghana.legacyCountryCode !== "GH") ||
        ghana.organizationId !== undefined) {
      throw new ConvexError("GHANA_SEED_V2_TYPE_CONFLICT");
    }
    const [draftDefaults, enabledDefaults] = await Promise.all([
      ctx.db
        .query("jurisdictions")
        .withIndex("by_isDefault_and_status", (q) =>
          q.eq("isDefault", true).eq("status", "draft"),
        )
        .take(2),
      ctx.db
        .query("jurisdictions")
        .withIndex("by_isDefault_and_status", (q) =>
          q.eq("isDefault", true).eq("status", "enabled"),
        )
        .take(2),
    ]);
    if ([...draftDefaults, ...enabledDefaults].some((row) => row._id !== ghana._id)) {
      throw new ConvexError("GHANA_SEED_V2_DEFAULT_CONFLICT");
    }
    const [profiles, placeRows, organizationalProfiles] = await Promise.all([
      ctx.db
        .query("geographicJurisdictions")
        .withIndex("by_jurisdictionId", (q) => q.eq("jurisdictionId", ghana._id))
        .take(2),
      ctx.db
        .query("geographicJurisdictions")
        .withIndex("by_googlePlaceId", (q) => q.eq("googlePlaceId", place.googlePlaceId))
        .take(2),
      ctx.db
        .query("organizationalJurisdictions")
        .withIndex("by_jurisdictionId", (q) => q.eq("jurisdictionId", ghana._id))
        .take(2),
    ]);
    if (organizationalProfiles.length > 0) {
      throw new ConvexError("GHANA_SEED_V2_TYPE_CONFLICT");
    }
    if (placeRows.some((profile) => profile.jurisdictionId !== ghana._id)) {
      throw new ConvexError("GHANA_SEED_V2_PLACE_ID_CONFLICT");
    }
    if (profiles.length > 1 || placeRows.length > 1) {
      throw new ConvexError("GHANA_SEED_V2_PROFILE_CONFLICT");
    }
    const profile = profiles[0];
    if (profile &&
        (profile.googlePlaceId !== place.googlePlaceId ||
          profile.level !== "country" || profile.countryCode !== "GH" ||
          profile.latitude !== place.latitude || profile.longitude !== place.longitude ||
          profile.formattedAddress !== place.formattedAddress ||
          profile.parentJurisdictionId !== undefined)) {
      throw new ConvexError("GHANA_SEED_V2_PROFILE_CONFLICT");
    }

    const now = Date.now();
    const jurisdictionPatch = {
      ...(ghana.kind === undefined ? { kind: "geographic" as const } : {}),
      ...(ghana.visibility === undefined ? { visibility: "public" as const } : {}),
      ...(ghana.legacyCountryCode === undefined ? { legacyCountryCode: "GH" } : {}),
      ...(ghana.status === "draft" ? {} : { status: "draft" as const }),
      ...(ghana.isDefault ? {} : { isDefault: true }),
      ...(ghana.providerSyncState === "pending"
        ? {}
        : { providerSyncState: "pending" as const }),
    };
    const jurisdictionChanged = Object.keys(jurisdictionPatch).length > 0;
    if (jurisdictionChanged) {
      await ctx.db.patch(ghana._id, {
        ...jurisdictionPatch,
        updatedBy: GHANA_V2_MIGRATION_ACTOR,
        updatedAt: now,
      });
    }
    if (!profile) {
      await ctx.db.insert("geographicJurisdictions", {
        jurisdictionId: ghana._id,
        googlePlaceId: place.googlePlaceId,
        level: "country",
        countryCode: "GH",
        latitude: place.latitude,
        longitude: place.longitude,
        formattedAddress: place.formattedAddress,
        createdAt: now,
        updatedAt: now,
      });
    }
    const result = {
      jurisdictionId: ghana._id,
      changed: jurisdictionChanged || !profile,
    };
    const rolloutPatch = {
      ghanaJurisdictionId: ghana._id,
      ghanaProjectionFingerprint: fingerprint,
      ghanaSeededAt: now,
      ghanaSeedLastIdempotencyKey: args.idempotencyKey,
      ghanaSeedLastRequestFingerprint: requestFingerprint,
      ghanaSeedLastResult: result,
      updatedAt: now,
    };
    if (rollout) {
      await ctx.db.patch(rollout._id, rolloutPatch);
    } else {
      await ctx.db.insert("unifiedJurisdictionRolloutStates", {
        environment,
        migrationVersion: JURISDICTION_MIGRATION_VERSION,
        ...rolloutPatch,
        legacyObservationGeneration: 0,
        legacyAcceptedSinceStart: 0,
      });
    }
    const correlationId = `op_${crypto.randomUUID().replaceAll("-", "")}`;
    await writeSystemMigrationAudit(ctx, {
      action: "migration.seed_ghana_jurisdiction_v2",
      targetId: ghana._id,
      reason,
      correlationId,
      metadata: {
        migration: JURISDICTION_MIGRATION_VERSION,
        changed: result.changed,
        projectionFingerprint: fingerprint,
        googlePlaceId: place.googlePlaceId,
      },
    });
    return result;
  },
});

function rowCode(migrationRow: MigrationRow): string | undefined {
  return migrationRow.row.country;
}

function isCanonicalStoredLegacyCode(value: string | undefined): value is string {
  return value !== undefined && value === value.trim().toUpperCase() &&
    isLegacyCountryCode(value);
}

async function classifyMigrationRow(
  ctx: MutationCtx,
  migrationRow: MigrationRow,
  cache: MigrationLookupCache,
): Promise<MigrationClassification> {
  const row = migrationRow.row;
  const code = rowCode(migrationRow);
  const contract = migrationRow.row.jurisdictionContract;
  if (!row.jurisdictionId) {
    if (contract === "unified" ||
        (contract === "legacy" && !isCanonicalStoredLegacyCode(code))) {
      return { status: "mismatch" };
    }
    if (!isCanonicalStoredLegacyCode(code)) return { status: "unresolved" };
    let resolution = cache.byLegacyCode.get(code);
    if (!resolution) {
      resolution = resolveLegacyJurisdictionSnapshot(ctx, code);
      cache.byLegacyCode.set(code, resolution);
    }
    const resolved = await resolution;
    if (!resolved) return { status: "unresolved" };
    if (row.jurisdictionKind !== undefined && row.jurisdictionKind !== "geographic") {
      return { status: "mismatch" };
    }
    return {
      status: "update",
      patch: {
        jurisdictionId: resolved.jurisdictionId,
        ...(!row.jurisdictionName?.trim()
          ? { jurisdictionName: resolved.jurisdictionName }
          : {}),
        ...(row.jurisdictionKind === undefined
          ? { jurisdictionKind: resolved.jurisdictionKind }
          : {}),
        jurisdictionContract: "legacy",
      },
    };
  }
  let jurisdictionRead = cache.byId.get(row.jurisdictionId);
  if (!jurisdictionRead) {
    jurisdictionRead = ctx.db.get("jurisdictions", row.jurisdictionId);
    cache.byId.set(row.jurisdictionId, jurisdictionRead);
  }
  const jurisdiction = await jurisdictionRead;
  if (!jurisdiction || jurisdiction.status !== "enabled" ||
      (jurisdiction.kind !== "geographic" && jurisdiction.kind !== "organizational")) {
    return { status: "unresolved" };
  }
  if (row.jurisdictionKind !== undefined && row.jurisdictionKind !== jurisdiction.kind) {
    return { status: "mismatch" };
  }
  if (contract === "legacy" &&
      (!isCanonicalStoredLegacyCode(code) || jurisdiction.kind !== "geographic")) {
    return { status: "mismatch" };
  }
  if (code !== undefined) {
    if (!isCanonicalStoredLegacyCode(code)) return { status: "mismatch" };
    let resolution = cache.byLegacyCode.get(code);
    if (!resolution) {
      resolution = resolveLegacyJurisdictionSnapshot(ctx, code);
      cache.byLegacyCode.set(code, resolution);
    }
    const resolved = await resolution;
    if (!resolved || resolved.jurisdictionId !== jurisdiction._id) {
      return { status: "mismatch" };
    }
  }
  const patch = {
    ...(!row.jurisdictionName?.trim()
      ? { jurisdictionName: jurisdiction.name }
      : {}),
    ...(row.jurisdictionKind === undefined
      ? { jurisdictionKind: jurisdiction.kind }
      : {}),
  };
  return Object.keys(patch).length > 0
    ? { status: "update", patch }
    : { status: "clean" };
}

async function paginateMigrationTarget(
  ctx: MutationCtx,
  target: JurisdictionMigrationTarget,
  databaseCursor: string | null,
  batchSize: number,
) {
  const paginationOpts = {
    cursor: databaseCursor,
    numItems: batchSize,
    maximumRowsRead: 101,
  };
  switch (target) {
    case "chatSessions": {
      const page = await ctx.db.query("chatSessions").paginate(paginationOpts);
      return { ...page, page: page.page.map((row) => ({ target, row }) satisfies MigrationRow) };
    }
  }
}

async function patchMigrationRow(
  ctx: MutationCtx,
  migrationRow: MigrationRow,
  patch: NonNullable<MigrationClassification["patch"]>,
): Promise<void> {
  await ctx.db.patch(migrationRow.row._id, patch);
}

export const backfillJurisdictionReferences = internalMutation({
  args: {
    environment: v.string(),
    target: jurisdictionMigrationTargetValidator,
    cursor: v.union(v.string(), v.null()),
    batchSize: v.number(),
    dryRun: v.boolean(),
    confirmation: v.string(),
    reason: v.string(),
    idempotencyKey: v.string(),
  },
  returns: migrationPageResultValidator,
  handler: async (ctx, args): Promise<MigrationPageResult> => {
    const environment = requireMigrationEnvironment(args.environment);
    if (!Number.isInteger(args.batchSize) || args.batchSize < 1 || args.batchSize > 100) {
      throw new ConvexError("JURISDICTION_MIGRATION_BATCH_SIZE_INVALID");
    }
    assertMigrationIdempotencyKey(args.idempotencyKey);
    const mode = args.dryRun ? "dry_run" as const : "execute" as const;
    const expected = `UNIFIED_JURISDICTIONS BACKFILL ${environment} ${args.target} ${args.dryRun ? "DRY_RUN" : "EXECUTE"}`;
    if (args.confirmation !== expected) {
      throw new ConvexError("JURISDICTION_MIGRATION_CONFIRMATION_MISMATCH");
    }
    const reason = validateAuditReason(args.reason);
    if (args.cursor !== null && !/^ujm1_[a-f0-9]{32}$/.test(args.cursor)) {
      throw new ConvexError("JURISDICTION_MIGRATION_CURSOR_INVALID");
    }
    const requestFingerprint = await sha256(canonicalJson({
      version: "jurisdiction_backfill_page_v1",
      environment,
      target: args.target,
      mode,
      cursor: args.cursor ?? "start",
      batchSize: args.batchSize,
      reason,
    }));
    const checkpoints = await ctx.db
      .query("jurisdictionMigrationCheckpoints")
      .withIndex(
        "by_environment_and_migrationVersion_and_target_and_mode",
        (q) => q
          .eq("environment", environment)
          .eq("migrationVersion", JURISDICTION_MIGRATION_VERSION)
          .eq("target", args.target)
          .eq("mode", mode),
      )
      .take(2);
    if (checkpoints.length > 1) {
      throw new ConvexError("JURISDICTION_MIGRATION_STATE_INVALID");
    }
    const checkpoint = checkpoints[0];
    if (checkpoint) assertMigrationCheckpointState(checkpoint);
    if (checkpoint?.lastIdempotencyKey === args.idempotencyKey) {
      if (checkpoint.lastRequestFingerprint !== requestFingerprint) {
        throw new ConvexError("JURISDICTION_MIGRATION_IDEMPOTENCY_CONFLICT");
      }
      return checkpoint.lastResult;
    }
    if (args.cursor === null && checkpoint?.status === "running") {
      throw new ConvexError("JURISDICTION_MIGRATION_RUN_IN_PROGRESS");
    }
    if (args.cursor !== null &&
        (!checkpoint || checkpoint.status !== "running" ||
          checkpoint.continuationToken !== args.cursor)) {
      throw new ConvexError("JURISDICTION_MIGRATION_CURSOR_STALE");
    }
    const runNumber = args.cursor === null ? (checkpoint?.runNumber ?? 0) + 1 : checkpoint!.runNumber;
    if (!Number.isSafeInteger(runNumber) || runNumber <= 0) {
      throw new ConvexError("JURISDICTION_MIGRATION_STATE_INVALID");
    }
    const databaseCursor = args.cursor === null ? null : checkpoint!.databaseCursor ?? null;
    let page: Awaited<ReturnType<typeof paginateMigrationTarget>>;
    try {
      page = await paginateMigrationTarget(ctx, args.target, databaseCursor, args.batchSize);
    } catch {
      throw new ConvexError("JURISDICTION_MIGRATION_STATE_INVALID");
    }
    let updated = 0;
    let unresolved = 0;
    let mismatches = 0;
    const lookupCache: MigrationLookupCache = {
      byId: new Map(),
      byLegacyCode: new Map(),
    };
    const classified: Array<{
      row: MigrationRow;
      classification: MigrationClassification;
    }> = [];
    for (const row of page.page) {
      const classification = await classifyMigrationRow(ctx, row, lookupCache);
      classified.push({ row, classification });
    }
    for (const item of classified) {
      const { row } = item;
      const { classification } = item;
      if (classification.status === "update") {
        updated += 1;
        if (!args.dryRun && classification.patch) {
          await patchMigrationRow(ctx, row, classification.patch);
        }
      } else if (classification.status === "unresolved") {
        unresolved += 1;
      } else if (classification.status === "mismatch") {
        mismatches += 1;
      }
    }
    const processed = page.page.length;
    const cumulative = {
      processed: (args.cursor === null ? 0 : checkpoint!.processed) + processed,
      updated: (args.cursor === null ? 0 : checkpoint!.updated) + updated,
      unresolved: (args.cursor === null ? 0 : checkpoint!.unresolved) + unresolved,
      mismatches: (args.cursor === null ? 0 : checkpoint!.mismatches) + mismatches,
    };
    if (Object.values(cumulative).some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new ConvexError("JURISDICTION_MIGRATION_STATE_INVALID");
    }
    const now = Date.now();
    const continuationToken = page.isDone
      ? null
      : `ujm1_${crypto.randomUUID().replaceAll("-", "")}`;
    const result = {
      processed,
      updated,
      unresolved,
      mismatches,
      continueCursor: continuationToken,
      isDone: page.isDone,
    };
    const cleanVerified = mode === "execute" && runNumber >= 2 && page.isDone &&
      cumulative.updated === 0 && cumulative.unresolved === 0 && cumulative.mismatches === 0;
    const checkpointValue = {
      environment,
      migrationVersion: JURISDICTION_MIGRATION_VERSION,
      target: args.target,
      mode,
      runNumber,
      status: page.isDone ? "completed" as const : "running" as const,
      ...(page.isDone ? {} : { databaseCursor: page.continueCursor }),
      ...(continuationToken ? { continuationToken } : {}),
      ...cumulative,
      startedAt: args.cursor === null ? now : checkpoint!.startedAt,
      ...(page.isDone ? { completedAt: now } : {}),
      ...(cleanVerified ? { verifiedAt: now } : {}),
      ...(args.cursor ? { lastInputToken: args.cursor } : {}),
      lastIdempotencyKey: args.idempotencyKey,
      lastRequestFingerprint: requestFingerprint,
      lastResult: result,
      updatedAt: now,
    };
    if (checkpoint) {
      await ctx.db.replace(checkpoint._id, checkpointValue);
    } else {
      await ctx.db.insert("jurisdictionMigrationCheckpoints", checkpointValue);
    }
    const correlationId = `op_${crypto.randomUUID().replaceAll("-", "")}`;
    await writeSystemMigrationAudit(ctx, {
      action: args.dryRun
        ? "migration.jurisdiction_references_dry_run_page"
        : "migration.jurisdiction_references_execute_page",
      targetId: `${JURISDICTION_MIGRATION_VERSION}.${args.target}.${mode}`,
      reason,
      correlationId,
      metadata: {
        target: args.target,
        mode,
        processed,
        updated,
        unresolved,
        mismatches,
        runNumber,
        isDone: page.isDone,
      },
    });
    return result;
  },
});


export const bootstrapSuperAdmins = internalMutation({
  args: {},
  returns: v.object({
    promoted: v.number(),
    unchanged: v.number(),
  }),
  handler: async (ctx) => {
    const allowlistedUserIds = parseInitialSuperAdminIds(
      process.env.INITIAL_SUPER_ADMIN_IDS,
    );
    let promoted = 0;
    let unchanged = 0;

    for (const targetUserId of allowlistedUserIds) {
      const target = await authComponent.getAnyUserById(ctx, targetUserId);
      if (!target) {
        throw new Error(`Allowlisted Better Auth user not found: ${targetUserId}`);
      }
      const currentRoles = parseAdminRoles(target.role);
      const result = await writeAdminRoles(ctx, {
        actorType: "system",
        targetUserId,
        roles: [...new Set([...currentRoles, "super_admin" as const])],
        auditAction: "admin.bootstrap_super_admin",
      });
      if (result.changed) {
        promoted += 1;
      } else {
        unchanged += 1;
      }
    }

    return { promoted, unchanged };
  },
});
