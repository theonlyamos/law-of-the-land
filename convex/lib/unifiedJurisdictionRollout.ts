import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export const JURISDICTION_MIGRATION_VERSION = "jurisdiction_ids_v1" as const;
export const JURISDICTION_MIGRATION_IDEMPOTENCY_KEY =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
export const JURISDICTION_MIGRATION_TARGETS = [
  "chatSessions",
] as const;

export type JurisdictionMigrationTarget =
  (typeof JURISDICTION_MIGRATION_TARGETS)[number];
export type JurisdictionMigrationMode = "dry_run" | "execute";

export async function ghanaProjectionFingerprint(projection: {
  googlePlaceId: string;
  formattedAddress: string;
  latitude: number;
  longitude: number;
}): Promise<string> {
  const canonical = JSON.stringify({
    version: "ghana_country_projection_v1",
    googlePlaceId: projection.googlePlaceId,
    formattedAddress: projection.formattedAddress,
    latitude: projection.latitude,
    longitude: projection.longitude,
    level: "country",
    countryCode: "GH",
  });
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const jurisdictionMigrationTargetValidator = v.literal("chatSessions");

export const migrationPageResultValidator = v.object({
  processed: v.number(),
  updated: v.number(),
  unresolved: v.number(),
  mismatches: v.number(),
  continueCursor: v.union(v.string(), v.null()),
  isDone: v.boolean(),
});

export type MigrationPageResult = {
  processed: number;
  updated: number;
  unresolved: number;
  mismatches: number;
  continueCursor: string | null;
  isDone: boolean;
};

function isSafeNonnegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

const MIGRATION_CONTINUATION_TOKEN = /^ujm1_[a-f0-9]{32}$/;

export function assertMigrationCheckpointState(
  checkpoint: Doc<"jurisdictionMigrationCheckpoints">,
): void {
  const page = checkpoint.lastResult;
  const counters = [
    checkpoint.processed,
    checkpoint.updated,
    checkpoint.unresolved,
    checkpoint.mismatches,
    page.processed,
    page.updated,
    page.unresolved,
    page.mismatches,
  ];
  const safeTimestamp = (value: number | undefined) =>
    value === undefined || isSafeNonnegativeInteger(value);
  const running = checkpoint.status === "running";
  if (!Number.isSafeInteger(checkpoint.runNumber) || checkpoint.runNumber <= 0 ||
      counters.some((value) => !isSafeNonnegativeInteger(value)) ||
      checkpoint.updated + checkpoint.unresolved + checkpoint.mismatches >
        checkpoint.processed ||
      page.processed > 100 ||
      page.updated + page.unresolved + page.mismatches > page.processed ||
      page.processed > checkpoint.processed ||
      page.updated > checkpoint.updated ||
      page.unresolved > checkpoint.unresolved ||
      page.mismatches > checkpoint.mismatches ||
      !safeTimestamp(checkpoint.startedAt) ||
      !safeTimestamp(checkpoint.completedAt) ||
      !safeTimestamp(checkpoint.verifiedAt) ||
      !safeTimestamp(checkpoint.updatedAt) ||
      !JURISDICTION_MIGRATION_IDEMPOTENCY_KEY.test(
        checkpoint.lastIdempotencyKey,
      ) ||
      !/^[a-f0-9]{64}$/.test(checkpoint.lastRequestFingerprint) ||
      (checkpoint.lastInputToken !== undefined &&
        !MIGRATION_CONTINUATION_TOKEN.test(checkpoint.lastInputToken)) ||
      checkpoint.startedAt > checkpoint.updatedAt ||
      (checkpoint.completedAt !== undefined &&
        (checkpoint.completedAt < checkpoint.startedAt ||
          checkpoint.completedAt > checkpoint.updatedAt)) ||
      running !== !page.isDone ||
      (running &&
        (!checkpoint.databaseCursor || !checkpoint.continuationToken ||
          !MIGRATION_CONTINUATION_TOKEN.test(checkpoint.continuationToken) ||
          checkpoint.completedAt !== undefined || checkpoint.verifiedAt !== undefined ||
          checkpoint.continuationToken !== page.continueCursor)) ||
      (!running &&
        (checkpoint.databaseCursor !== undefined ||
          checkpoint.continuationToken !== undefined ||
          page.continueCursor !== null || checkpoint.completedAt === undefined)) ||
      (checkpoint.verifiedAt !== undefined &&
        (checkpoint.mode !== "execute" || checkpoint.runNumber < 2 || running ||
          checkpoint.updated !== 0 || checkpoint.unresolved !== 0 ||
          checkpoint.mismatches !== 0 || checkpoint.completedAt === undefined ||
          checkpoint.verifiedAt < checkpoint.startedAt ||
          checkpoint.verifiedAt > checkpoint.completedAt))) {
    throw new ConvexError("JURISDICTION_MIGRATION_STATE_INVALID");
  }
}

export const rolloutTargetStateValidator = v.object({
  target: jurisdictionMigrationTargetValidator,
  status: v.union(
    v.literal("missing"),
    v.literal("running"),
    v.literal("blocked"),
    v.literal("verified"),
  ),
  processed: v.number(),
  updated: v.number(),
  unresolved: v.number(),
  mismatches: v.number(),
  runNumber: v.number(),
  verifiedAt: v.union(v.number(), v.null()),
});

export const unifiedJurisdictionRolloutStateValidator = v.object({
  environment: v.string(),
  migrationVersion: v.literal("jurisdiction_ids_v1"),
  flagEnabled: v.boolean(),
  ghana: v.object({
    ready: v.boolean(),
    jurisdictionId: v.union(v.id("jurisdictions"), v.null()),
    reasons: v.array(v.string()),
  }),
  targets: v.array(rolloutTargetStateValidator),
  blockers: v.array(v.string()),
  canEnable: v.boolean(),
  legacyObservation: v.object({
    active: v.boolean(),
    generation: v.number(),
    startedAt: v.union(v.number(), v.null()),
    lastAcceptedAt: v.union(v.number(), v.null()),
    acceptedSinceStart: v.number(),
    zeroForMs: v.union(v.number(), v.null()),
  }),
});

export type UnifiedJurisdictionRolloutState = {
  environment: string;
  migrationVersion: typeof JURISDICTION_MIGRATION_VERSION;
  flagEnabled: boolean;
  ghana: {
    ready: boolean;
    jurisdictionId: Id<"jurisdictions"> | null;
    reasons: string[];
  };
  targets: Array<{
    target: JurisdictionMigrationTarget;
    status: "missing" | "running" | "blocked" | "verified";
    processed: number;
    updated: number;
    unresolved: number;
    mismatches: number;
    runNumber: number;
    verifiedAt: number | null;
  }>;
  blockers: string[];
  canEnable: boolean;
  legacyObservation: {
    active: boolean;
    generation: number;
    startedAt: number | null;
    lastAcceptedAt: number | null;
    acceptedSinceStart: number;
    zeroForMs: number | null;
  };
};

type DatabaseCtx = Pick<QueryCtx, "db">;

export function readMigrationEnvironment(): string {
  const environment = process.env.ADMIN_ENVIRONMENT;
  if (!environment || environment.trim() !== environment) {
    throw new ConvexError("JURISDICTION_MIGRATION_ENVIRONMENT_INVALID");
  }
  return environment;
}

export function requireMigrationEnvironment(supplied: string): string {
  const environment = readMigrationEnvironment();
  if (supplied !== environment) {
    throw new ConvexError("JURISDICTION_MIGRATION_ENVIRONMENT_INVALID");
  }
  return environment;
}

export async function readRolloutStateRow(
  ctx: DatabaseCtx,
  environment: string,
): Promise<Doc<"unifiedJurisdictionRolloutStates"> | null> {
  const rows = await ctx.db
    .query("unifiedJurisdictionRolloutStates")
    .withIndex("by_environment_and_migrationVersion", (q) =>
      q
        .eq("environment", environment)
        .eq("migrationVersion", JURISDICTION_MIGRATION_VERSION),
    )
    .take(2);
  if (rows.length > 1) {
    throw new ConvexError("JURISDICTION_MIGRATION_STATE_INVALID");
  }
  const row = rows[0];
  if (!row) return null;
  const safeTimestamp = (value: number | undefined) =>
    value === undefined || (Number.isSafeInteger(value) && value >= 0);
  const seedFields = [
    row.ghanaJurisdictionId,
    row.ghanaProjectionFingerprint,
    row.ghanaSeededAt,
    row.ghanaSeedLastIdempotencyKey,
    row.ghanaSeedLastRequestFingerprint,
    row.ghanaSeedLastResult,
  ];
  const seedCount = seedFields.filter((value) => value !== undefined).length;
  const completeSeed = seedCount === 0 ||
    (seedCount === seedFields.length &&
      /^[a-f0-9]{64}$/.test(row.ghanaProjectionFingerprint!) &&
      JURISDICTION_MIGRATION_IDEMPOTENCY_KEY.test(row.ghanaSeedLastIdempotencyKey!) &&
      /^[a-f0-9]{64}$/.test(row.ghanaSeedLastRequestFingerprint!) &&
      row.ghanaSeedLastResult!.jurisdictionId === row.ghanaJurisdictionId &&
      typeof row.ghanaSeedLastResult!.changed === "boolean");
  if (!Number.isSafeInteger(row.legacyObservationGeneration) ||
      row.legacyObservationGeneration < 0 ||
      !Number.isSafeInteger(row.legacyAcceptedSinceStart) ||
      row.legacyAcceptedSinceStart < 0 ||
      !safeTimestamp(row.legacyObservationStartedAt) ||
      !safeTimestamp(row.legacyLastAcceptedAt) ||
      !safeTimestamp(row.ghanaSeededAt) ||
      !safeTimestamp(row.updatedAt) ||
      !completeSeed ||
      (row.ghanaSeededAt !== undefined && row.ghanaSeededAt > row.updatedAt) ||
      (row.legacyObservationStartedAt === undefined &&
        row.legacyLastAcceptedAt !== undefined) ||
      (row.legacyObservationStartedAt !== undefined &&
        row.legacyObservationStartedAt > row.updatedAt) ||
      (row.legacyObservationStartedAt !== undefined &&
        row.legacyLastAcceptedAt !== undefined &&
        (row.legacyLastAcceptedAt < row.legacyObservationStartedAt ||
          row.legacyLastAcceptedAt > row.updatedAt))) {
    throw new ConvexError("JURISDICTION_MIGRATION_STATE_INVALID");
  }
  return row;
}

export async function recordLegacyJurisdictionDependency(
  ctx: MutationCtx,
  environment: string,
  acceptedAt: number,
): Promise<void> {
  const row = await readRolloutStateRow(ctx, environment);
  if (!row || row.legacyObservationStartedAt === undefined) {
    throw new ConvexError("JURISDICTION_MIGRATION_STATE_INVALID");
  }
  if (!Number.isSafeInteger(row.legacyAcceptedSinceStart) ||
      row.legacyAcceptedSinceStart < 0 ||
      row.legacyAcceptedSinceStart >= Number.MAX_SAFE_INTEGER) {
    throw new ConvexError("JURISDICTION_MIGRATION_STATE_INVALID");
  }
  const observedAt = Math.max(
    acceptedAt,
    row.legacyObservationStartedAt,
    row.updatedAt,
  );
  await ctx.db.patch(row._id, {
    legacyAcceptedSinceStart: row.legacyAcceptedSinceStart + 1,
    legacyLastAcceptedAt: observedAt,
    updatedAt: observedAt,
  });
}

function targetBlocker(target: JurisdictionMigrationTarget): string {
  switch (target) {
    case "chatSessions":
      return "CHAT_SESSIONS_NOT_VERIFIED";
  }
}

function safeCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

async function readGhanaReadiness(
  ctx: DatabaseCtx,
  rollout: Doc<"unifiedJurisdictionRolloutStates"> | null,
) {
  const reasons: string[] = [];
  const ghanaRows = await ctx.db
    .query("jurisdictions")
    .withIndex("by_code", (q) => q.eq("code", "GH"))
    .take(2);
  if (ghanaRows.length !== 1) reasons.push("GHANA_CODE_STATE_INVALID");
  const ghana = ghanaRows.length === 1 ? ghanaRows[0] : null;
  if (!rollout?.ghanaJurisdictionId ||
      !/^[a-f0-9]{64}$/.test(rollout.ghanaProjectionFingerprint ?? "") ||
      rollout.ghanaSeededAt === undefined ||
      !rollout.ghanaSeedLastIdempotencyKey ||
      !/^[a-f0-9]{64}$/.test(rollout.ghanaSeedLastRequestFingerprint ?? "") ||
      !rollout.ghanaSeedLastResult ||
      rollout.ghanaSeedLastResult.jurisdictionId !== rollout.ghanaJurisdictionId) {
    reasons.push("GHANA_SEED_STATE_MISSING");
  }
  if (!ghana || !rollout || ghana._id !== rollout.ghanaJurisdictionId ||
      ghana.status !== "enabled" || ghana.isDefault !== true ||
      ghana.kind !== "geographic" || ghana.visibility !== "public" ||
      ghana.organizationId !== undefined ||
      ghana.legacyCountryCode !== "GH" ||
      ghana.providerSyncState !== "synced") {
    reasons.push("GHANA_JURISDICTION_INVALID");
  }
  if (ghana) {
    const [profiles, organizationalProfiles, draftDefaults, enabledDefaults] =
      await Promise.all([
        ctx.db
          .query("geographicJurisdictions")
          .withIndex("by_jurisdictionId", (q) =>
            q.eq("jurisdictionId", ghana._id),
          )
          .take(2),
        ctx.db
          .query("organizationalJurisdictions")
          .withIndex("by_jurisdictionId", (q) =>
            q.eq("jurisdictionId", ghana._id),
          )
          .take(2),
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
    if (organizationalProfiles.length > 0) {
      reasons.push("GHANA_JURISDICTION_INVALID");
    }
    if ([...draftDefaults, ...enabledDefaults].some((row) => row._id !== ghana._id)) {
      reasons.push("GHANA_DEFAULT_STATE_INVALID");
    }
    if (profiles.length !== 1 || profiles[0].level !== "country" ||
        profiles[0].countryCode !== "GH" ||
        profiles[0].parentJurisdictionId !== undefined) {
      reasons.push("GHANA_PROFILE_INVALID");
    } else {
      const actualFingerprint = await ghanaProjectionFingerprint({
        googlePlaceId: profiles[0].googlePlaceId,
        formattedAddress: profiles[0].formattedAddress,
        latitude: profiles[0].latitude,
        longitude: profiles[0].longitude,
      });
      if (actualFingerprint !== rollout?.ghanaProjectionFingerprint) {
        reasons.push("GHANA_PROFILE_INVALID");
      }
      const placeRows = await ctx.db
        .query("geographicJurisdictions")
        .withIndex("by_googlePlaceId", (q) =>
          q.eq("googlePlaceId", profiles[0].googlePlaceId),
        )
        .take(2);
      if (placeRows.length !== 1 || placeRows[0]._id !== profiles[0]._id) {
        reasons.push("GHANA_PLACE_ID_INVALID");
      }
    }
  }
  return {
    ready: reasons.length === 0,
    jurisdictionId: ghana?._id ?? null,
    reasons: [...new Set(reasons)].slice(0, 5),
  };
}

export async function calculateUnifiedJurisdictionRolloutState(
  ctx: DatabaseCtx,
  environment: string,
  now = Date.now(),
): Promise<UnifiedJurisdictionRolloutState> {
  const rollout = await readRolloutStateRow(ctx, environment);
  const flags = await ctx.db
    .query("featureFlags")
    .withIndex("by_key_and_environment", (q) =>
      q.eq("key", "unified_jurisdictions").eq("environment", environment),
    )
    .take(2);
  if (flags.length > 1) throw new ConvexError("ADMIN_FLAG_STATE_INVALID");
  const ghana = await readGhanaReadiness(ctx, rollout);
  const targets: UnifiedJurisdictionRolloutState["targets"] = [];
  for (const target of JURISDICTION_MIGRATION_TARGETS) {
    const rows = await ctx.db
      .query("jurisdictionMigrationCheckpoints")
      .withIndex(
        "by_environment_and_migrationVersion_and_target_and_mode",
        (q) =>
          q
            .eq("environment", environment)
            .eq("migrationVersion", JURISDICTION_MIGRATION_VERSION)
            .eq("target", target)
            .eq("mode", "execute"),
      )
      .take(2);
    if (rows.length > 1) {
      throw new ConvexError("JURISDICTION_MIGRATION_STATE_INVALID");
    }
    const row = rows[0];
    if (row) assertMigrationCheckpointState(row);
    const countersValid = row !== undefined &&
      safeCounter(row.processed) && safeCounter(row.updated) &&
      safeCounter(row.unresolved) && safeCounter(row.mismatches) &&
      Number.isSafeInteger(row.runNumber) && row.runNumber > 0;
    const verified = countersValid && row?.status === "completed" &&
      row.updated === 0 && row.unresolved === 0 && row.mismatches === 0 &&
      row.verifiedAt !== undefined && row.completedAt !== undefined &&
      row.verifiedAt >= row.startedAt && row.verifiedAt <= row.completedAt;
    targets.push({
      target,
      status: !row
        ? "missing"
        : row.status === "running"
          ? "running"
          : verified
            ? "verified"
            : "blocked",
      processed: countersValid ? row!.processed : 0,
      updated: countersValid ? row!.updated : 0,
      unresolved: countersValid ? row!.unresolved : 0,
      mismatches: countersValid ? row!.mismatches : 0,
      runNumber: countersValid ? row!.runNumber : 0,
      verifiedAt: verified ? row!.verifiedAt! : null,
    });
  }
  const blockers = [
    ...(ghana.ready ? [] : ["GHANA_NOT_READY"]),
    ...targets
      .filter((target) => target.status !== "verified")
      .map((target) => targetBlocker(target.target)),
  ];
  const startedAt = rollout?.legacyObservationStartedAt;
  const lastAcceptedAt = rollout?.legacyLastAcceptedAt;
  const active = startedAt !== undefined;
  const baseline = active
    ? Math.max(startedAt, lastAcceptedAt ?? startedAt)
    : null;
  return {
    environment,
    migrationVersion: JURISDICTION_MIGRATION_VERSION,
    flagEnabled: flags.length === 1 && flags[0].enabled,
    ghana,
    targets,
    blockers,
    canEnable: blockers.length === 0,
    legacyObservation: {
      active,
      generation: rollout?.legacyObservationGeneration ?? 0,
      startedAt: startedAt ?? null,
      lastAcceptedAt: lastAcceptedAt ?? null,
      acceptedSinceStart: rollout?.legacyAcceptedSinceStart ?? 0,
      zeroForMs: baseline === null ? null : Math.max(0, now - baseline),
    },
  };
}
