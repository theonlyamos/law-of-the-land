import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  chatCitationValidator,
  geographicLevelValidator,
  jurisdictionKindValidator,
  jurisdictionVisibilityValidator,
  organizationClassValidator,
  organizationMembershipStatusValidator,
  organizationScopeModeValidator,
  organizationStatusValidator,
} from "./lib/jurisdictionDomain";

export default defineSchema({
  jurisdictions: defineTable({
    code: v.optional(v.string()),
    name: v.string(),
    slug: v.string(),
    status: v.union(
      v.literal("draft"),
      v.literal("enabled"),
      v.literal("archived"),
    ),
    isDefault: v.boolean(),
    geminiFileSearchStoreName: v.optional(v.string()),
    geminiEmbeddingModel: v.optional(v.string()),
    providerSyncState: v.union(
      v.literal("pending"),
      v.literal("synced"),
      v.literal("drifted"),
      v.literal("failed"),
    ),
    kind: v.optional(jurisdictionKindValidator),
    visibility: v.optional(jurisdictionVisibilityValidator),
    organizationId: v.optional(v.id("organizations")),
    legacyCountryCode: v.optional(v.string()),
    createdBy: v.string(),
    updatedBy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_code", ["code"])
    .index("by_code_and_status", ["code", "status"])
    .index("by_status_and_code", ["status", "code"])
    .index("by_legacyCountryCode_and_status", ["legacyCountryCode", "status"])
    .index("by_slug", ["slug"])
    .index("by_status_and_name", ["status", "name"])
    .index("by_kind_and_status_and_name", ["kind", "status", "name"])
    .index("by_kind_and_status_and_visibility_and_name", [
      "kind",
      "status",
      "visibility",
      "name",
    ])
    .index("by_kind_and_name", ["kind", "name"])
    .index("by_name", ["name"])
    .index("by_isDefault", ["isDefault"])
    .index("by_isDefault_and_status", ["isDefault", "status"])
    .index("by_organizationId", ["organizationId"])
    .index("by_gemini_store_name", ["geminiFileSearchStoreName"])
    .searchIndex("search_name", {
      searchField: "name",
      filterFields: ["kind", "status", "visibility"],
    }),
  geographicJurisdictions: defineTable({
    jurisdictionId: v.id("jurisdictions"),
    googlePlaceId: v.string(),
    level: geographicLevelValidator,
    countryCode: v.optional(v.string()),
    latitude: v.number(),
    longitude: v.number(),
    formattedAddress: v.string(),
    parentJurisdictionId: v.optional(v.id("jurisdictions")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_jurisdictionId", ["jurisdictionId"])
    .index("by_googlePlaceId", ["googlePlaceId"])
    .index("by_parentJurisdictionId", ["parentJurisdictionId"]),
  geographicJurisdictionAliases: defineTable({
    jurisdictionId: v.id("jurisdictions"),
    normalizedAlias: v.string(),
    source: v.string(),
    createdAt: v.number(),
  })
    .index("by_normalizedAlias", ["normalizedAlias"])
    .index("by_jurisdictionId_and_normalizedAlias", [
      "jurisdictionId",
      "normalizedAlias",
    ]),
  organizations: defineTable({
    name: v.string(),
    slug: v.string(),
    class: organizationClassValidator,
    website: v.optional(v.string()),
    status: organizationStatusValidator,
    createdBy: v.string(),
    updatedBy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_status_and_name", ["status", "name"])
    .searchIndex("search_name", {
      searchField: "name",
      filterFields: ["status"],
    }),
  organizationMemberships: defineTable({
    organizationId: v.id("organizations"),
    userId: v.string(),
    status: organizationMembershipStatusValidator,
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_userId_and_status", ["userId", "status"])
    .index("by_organizationId_and_status", ["organizationId", "status"])
    .index("by_organizationId_and_userId", ["organizationId", "userId"]),
  organizationalJurisdictions: defineTable({
    jurisdictionId: v.id("jurisdictions"),
    scopeMode: organizationScopeModeValidator,
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_jurisdictionId", ["jurisdictionId"]),
  organizationGeographicScopes: defineTable({
    organizationalJurisdictionId: v.id("organizationalJurisdictions"),
    geographicJurisdictionId: v.id("geographicJurisdictions"),
    createdAt: v.number(),
  })
    .index("by_organizationalJurisdictionId_and_geographicJurisdictionId", [
      "organizationalJurisdictionId",
      "geographicJurisdictionId",
    ])
    .index("by_geographicJurisdictionId_and_organizationalJurisdictionId", [
      "geographicJurisdictionId",
      "organizationalJurisdictionId",
    ]),
  legalResources: defineTable({
    jurisdictionId: v.id("jurisdictions"),
    type: v.union(
      v.literal("constitution"),
      v.literal("act"),
      v.literal("regulation"),
      v.literal("ordinance"),
      v.literal("judgment"),
      v.literal("policy"),
      v.literal("guidance"),
    ),
    title: v.string(),
    issuer: v.string(),
    officialCitation: v.string(),
    officialCitationKey: v.string(),
    sourceUrl: v.string(),
    topics: v.array(v.string()),
    effectiveDate: v.string(),
    repealDate: v.optional(v.string()),
    status: v.union(
      v.literal("active"),
      v.literal("repealed"),
      v.literal("archived"),
    ),
    activeVersionId: v.optional(v.id("documentVersions")),
    createdBy: v.string(),
    updatedBy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_jurisdictionId_and_status", ["jurisdictionId", "status"])
    .index("by_jurisdictionId_and_updatedAt", ["jurisdictionId", "updatedAt"])
    .index("by_jurisdictionId_and_officialCitation", [
      "jurisdictionId",
      "officialCitation",
    ])
    .index("by_jurisdictionId_and_officialCitationKey", [
      "jurisdictionId",
      "officialCitationKey",
    ])
    .index("by_status_and_updatedAt", ["status", "updatedAt"])
    .index("by_activeVersionId", ["activeVersionId"]),
  documentVersions: defineTable({
    resourceId: v.id("legalResources"),
    versionNumber: v.number(),
    originalStorageId: v.id("_storage"),
    filename: v.string(),
    mimeType: v.string(),
    byteSize: v.number(),
    sha256: v.string(),
    sourceUrl: v.string(),
    effectiveDate: v.optional(v.string()),
    repealDate: v.optional(v.string()),
    status: v.union(
      v.literal("draft"),
      v.literal("ready_for_review"),
      v.literal("approved"),
      v.literal("publishing"),
      v.literal("published"),
      v.literal("rejected"),
      v.literal("superseded"),
      v.literal("unpublished"),
      v.literal("archived"),
    ),
    geminiDocumentName: v.optional(v.string()),
    geminiIndexedAt: v.optional(v.number()),
    submittedBy: v.string(),
    reviewedBy: v.optional(v.string()),
    submittedAt: v.optional(v.number()),
    reviewedAt: v.optional(v.number()),
    publishedAt: v.optional(v.number()),
    unpublishedAt: v.optional(v.number()),
    failureSummary: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_resourceId_and_versionNumber", ["resourceId", "versionNumber"])
    .index("by_status_and_updatedAt", ["status", "updatedAt"])
    .index("by_resourceId_and_sha256", ["resourceId", "sha256"])
    .index("by_resourceId_and_status", ["resourceId", "status"])
    .index("by_originalStorageId", ["originalStorageId"]),
  reviewDecisions: defineTable({
    documentVersionId: v.id("documentVersions"),
    reviewerId: v.string(),
    decision: v.union(v.literal("approve"), v.literal("reject")),
    notes: v.string(),
    checklistAnswers: v.record(v.string(), v.boolean()),
    evaluationRunId: v.optional(v.string()),
    reason: v.string(),
    correlationId: v.string(),
    createdAt: v.number(),
  })
    .index("by_documentVersionId_and_createdAt", [
      "documentVersionId",
      "createdAt",
    ])
    .index("by_decision_and_createdAt", ["decision", "createdAt"]),
  documentLifecycleLocks: defineTable({
    resourceId: v.id("legalResources"),
    versionId: v.id("documentVersions"),
    operation: v.union(
      v.literal("publish"),
      v.literal("unpublish"),
      v.literal("rollback"),
      v.literal("stage"),
    ),
    actorId: v.string(),
    idempotencyKey: v.string(),
    jobId: v.optional(v.id("integrationJobs")),
    expiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_resourceId", ["resourceId"])
    .index("by_jobId", ["jobId"]),
  resourceVersionCounters: defineTable({
    resourceId: v.id("legalResources"),
    nextVersionNumber: v.number(),
    updatedAt: v.number(),
  }).index("by_resourceId", ["resourceId"]),
  auditEvents: defineTable({
    actorType: v.union(v.literal("system"), v.literal("user")),
    actorUserId: v.optional(v.string()),
    // Governance fields are optional while Task 3's bootstrap and role-change
    // rows continue to use their original shape.
    actorId: v.optional(v.string()),
    actorRoles: v.optional(v.array(v.string())),
    action: v.string(),
    targetType: v.string(),
    targetId: v.string(),
    reason: v.optional(v.string()),
    beforeSummary: v.optional(v.string()),
    afterSummary: v.optional(v.string()),
    correlationId: v.optional(v.string()),
    outcome: v.optional(
      v.union(
        v.literal("success"),
        v.literal("failure"),
        v.literal("denied"),
      ),
    ),
    metadata: v.record(
      v.string(),
      v.union(v.string(), v.number(), v.boolean(), v.null()),
    ),
    createdAt: v.number(),
  })
    .index("by_createdAt", ["createdAt"])
    .index("by_actorId_and_createdAt", ["actorId", "createdAt"])
    .index("by_action_and_createdAt", ["action", "createdAt"])
    .index("by_outcome_and_createdAt", ["outcome", "createdAt"])
    .index("by_targetType_and_createdAt", ["targetType", "createdAt"])
    .index("by_targetType_and_targetId", ["targetType", "targetId"]),
  adminOperations: defineTable({
    actorId: v.string(),
    action: v.string(),
    targetId: v.string(),
    idempotencyKey: v.string(),
    requestFingerprint: v.string(),
    correlationId: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("queued"),
      v.literal("authorized"),
    ),
    result: v.optional(
      v.object({
        status: v.union(
          v.literal("succeeded"),
          v.literal("failed"),
          v.literal("queued"),
          v.literal("authorized"),
        ),
        correlationId: v.string(),
        action: v.string(),
        targetId: v.string(),
      }),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_actorId_and_idempotencyKey", [
      "actorId",
      "idempotencyKey",
    ])
    .index("by_action_and_targetId_and_createdAt", [
      "action",
      "targetId",
      "createdAt",
    ])
    .index("by_status_and_updatedAt", ["status", "updatedAt"]),
  adminStepUpProofs: defineTable({
    actorId: v.string(),
    sessionId: v.string(),
    action: v.string(),
    targetId: v.string(),
    idempotencyKey: v.string(),
    issuedAt: v.number(),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
  }).index(
    "by_actorId_sessionId_action_targetId_idempotencyKey",
    ["actorId", "sessionId", "action", "targetId", "idempotencyKey"],
  ),
  userDeletionRequests: defineTable({
    operationId: v.id("adminOperations"),
    actorId: v.string(),
    targetUserId: v.string(),
    executeAfter: v.number(),
    status: v.union(
      v.literal("queued"),
      v.literal("executing"),
      v.literal("completed"),
      v.literal("cancelled"),
      v.literal("failed"),
    ),
    phase: v.optional(
      v.union(
        v.literal("sessions"),
        v.literal("accounts"),
        v.literal("two_factor"),
        v.literal("user"),
      ),
    ),
    cursor: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status_and_executeAfter", ["status", "executeAfter"])
    .index("by_targetUserId_and_status", ["targetUserId", "status"]),
  verificationEmailRequests: defineTable({
    operationId: v.id("adminOperations"),
    actorId: v.string(),
    targetUserId: v.string(),
    targetEmail: v.string(),
    status: v.union(
      v.literal("queued"),
      v.literal("executing"),
      v.literal("unknown"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    leaseExpiresAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status_and_createdAt", ["status", "createdAt"])
    .index("by_targetUserId_and_createdAt", ["targetUserId", "createdAt"]),
  integrationJobs: defineTable({
    type: v.union(
      v.literal("gemini_create_store"),
      v.literal("gemini_index_document"),
      v.literal("gemini_delete_document"),
      v.literal("gemini_delete_store"),
    ),
    targetType: v.string(),
    targetId: v.string(),
    payload: v.string(),
    actorId: v.string(),
    actorRoles: v.array(
      v.union(
        v.literal("super_admin"),
        v.literal("content_manager"),
        v.literal("content_reviewer"),
        v.literal("support_agent"),
        v.literal("billing_manager"),
        v.literal("auditor"),
      ),
    ),
    idempotencyKey: v.string(),
    requestFingerprint: v.string(),
    correlationId: v.string(),
    providerOperationName: v.optional(v.string()),
    providerPollCount: v.optional(v.number()),
    recoveryKind: v.optional(v.union(v.literal("poll_operation"), v.literal("delete_document"))),
    leaseToken: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("waiting_provider"),
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("cancelled"),
      v.literal("manual_review"),
    ),
    attemptCount: v.number(),
    nextAttemptAt: v.optional(v.number()),
    lastErrorKind: v.optional(
      v.union(
        v.literal("invalid_request"),
        v.literal("validation"),
        v.literal("authentication"),
        v.literal("not_found"),
        v.literal("rate_limit"),
        v.literal("timeout"),
        v.literal("network"),
        v.literal("invalid_response"),
        v.literal("provider"),
      ),
    ),
    retentionPending: v.optional(v.boolean()),
    retentionRedactedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_actorId_and_idempotencyKey", ["actorId", "idempotencyKey"])
    .index("by_providerOperationName", ["providerOperationName"])
    .index("by_status_and_nextAttemptAt", ["status", "nextAttemptAt"])
    .index("by_createdAt", ["createdAt"])
    .index("by_status_and_createdAt", ["status", "createdAt"])
    .index("by_status_and_retentionPending_and_createdAt", ["status", "retentionPending", "createdAt"])
    .index("by_type_and_createdAt", ["type", "createdAt"])
    .index("by_status_and_type_and_createdAt", ["status", "type", "createdAt"])
    .index("by_targetType_and_targetId", ["targetType", "targetId"])
    .index("by_targetType_and_targetId_and_type_and_status", ["targetType", "targetId", "type", "status"]),
  e2eFixtureOwnership: defineTable({
    tag: v.string(),
    kind: v.union(
      v.literal("better_auth_user"),
      v.literal("system_incident"),
      v.literal("admin_operation"),
      v.literal("quota_override"),
    ),
    targetId: v.string(),
    createdAt: v.number(),
  })
    .index("by_tag_and_kind", ["tag", "kind"])
    .index("by_targetId", ["targetId"]),
  e2eProviderStubOutcomes: defineTable({
    tag: v.string(),
    targetId: v.string(),
    operation: v.union(v.literal("publish"), v.literal("rollback"), v.literal("unpublish")),
    outcome: v.union(v.literal("succeeded"), v.literal("failed")),
    armedAt: v.number(),
    consumedAt: v.optional(v.number()),
    jobId: v.optional(v.id("integrationJobs")),
  })
    .index("by_tag", ["tag"])
    .index("by_targetId_and_operation", ["targetId", "operation"]),
  e2eFixtureRuns: defineTable({
    tag: v.string(),
    environment: v.union(v.literal("test"), v.literal("preview")),
    state: v.union(
      v.literal("bootstrapping"),
      v.literal("ready"),
      v.literal("cleaning"),
      v.literal("cleanup_conflict"),
    ),
    priorFlag: v.union(
      v.object({ kind: v.literal("absent") }),
      v.object({
        kind: v.literal("present"),
        rowId: v.id("featureFlags"),
        enabled: v.boolean(),
        updatedAt: v.number(),
        updatedBy: v.optional(v.string()),
      }),
    ),
    fixtureFlagWrite: v.object({
      rowId: v.id("featureFlags"),
      enabled: v.boolean(),
      updatedAt: v.number(),
      updatedBy: v.string(),
    }),
    approvedCommitSha: v.string(),
    deployedCommitSha: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_tag", ["tag"])
    .index("by_environment", ["environment"]),
  adminAccessGrants: defineTable({
    adminId: v.string(),
    chatSessionId: v.id("chatSessions"),
    purpose: v.string(),
    issuedAt: v.number(),
    expiresAt: v.number(),
    revokedAt: v.optional(v.number()),
    correlationId: v.optional(v.string()),
  }).index("by_adminId_and_chatSessionId_and_expiresAt", [
    "adminId",
    "chatSessionId",
    "expiresAt",
  ]).index("by_expiresAt", ["expiresAt"]),
  adminExports: defineTable({
    correlationId: v.string(),
    requesterId: v.string(),
    requesterSessionId: v.string(),
    chatSessionId: v.id("chatSessions"),
    accessGrantId: v.id("adminAccessGrants"),
    status: v.union(
      v.literal("queued"),
      v.literal("ready"),
      v.literal("failed"),
      v.literal("expired"),
    ),
    storageId: v.optional(v.id("_storage")),
    expiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_correlationId", ["correlationId"])
    .index("by_storageId", ["storageId"])
    .index("by_status_and_expiresAt", ["status", "expiresAt"]),
  exportDownloadReferences: defineTable({
    exportId: v.id("adminExports"),
    requesterId: v.string(),
    referenceHash: v.string(),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_referenceHash", ["referenceHash"])
    .index("by_exportId_and_createdAt", ["exportId", "createdAt"])
    .index("by_expiresAt", ["expiresAt"]),
  systemIncidents: defineTable({
    title: v.string(),
    severity: v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("critical")),
    status: v.union(v.literal("open"), v.literal("investigating"), v.literal("monitoring"), v.literal("resolved")),
    ownerId: v.optional(v.string()),
    createdBy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_status_and_updatedAt", ["status", "updatedAt"])
    .index("by_severity_and_updatedAt", ["severity", "updatedAt"])
    .index("by_status_and_severity_and_updatedAt", ["status", "severity", "updatedAt"]),
  incidentTimeline: defineTable({
    incidentId: v.id("systemIncidents"),
    kind: v.union(v.literal("created"), v.literal("note"), v.literal("status"), v.literal("ownership"), v.literal("severity")),
    actorId: v.string(),
    summary: v.string(),
    createdAt: v.number(),
  }).index("by_incidentId_and_createdAt", ["incidentId", "createdAt"]),
  retentionState: defineTable({
    key: v.literal("default"),
    phase: v.string(),
    cursor: v.optional(v.string()),
    cycleHadChanges: v.optional(v.boolean()),
    storagePassHadChanges: v.optional(v.boolean()),
    deletedTotal: v.number(),
    lastStartedAt: v.number(),
    lastSuccessfulAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),
  jobControlResults: defineTable({
    operationId: v.id("adminOperations"),
    jobId: v.id("integrationJobs"),
    status: v.union(v.literal("queued"), v.literal("running"), v.literal("cancelled")),
    correlationId: v.string(),
    createdAt: v.number(),
  }).index("by_operationId", ["operationId"]),
  featureFlags: defineTable({
    key: v.union(v.literal("admin_panel"), v.literal("unified_jurisdictions")),
    environment: v.string(),
    enabled: v.boolean(),
    updatedAt: v.number(),
    updatedBy: v.optional(v.string()),
  }).index("by_key_and_environment", ["key", "environment"]),
  jurisdictionMigrationCheckpoints: defineTable({
    environment: v.string(),
    migrationVersion: v.literal("jurisdiction_ids_v1"),
    target: v.union(
      v.literal("chatSessions"),
      v.literal("telemetryCorrelations"),
      v.literal("queryRuns"),
      v.literal("dailyMetrics"),
    ),
    mode: v.union(v.literal("dry_run"), v.literal("execute")),
    runNumber: v.number(),
    status: v.union(v.literal("running"), v.literal("completed")),
    databaseCursor: v.optional(v.string()),
    continuationToken: v.optional(v.string()),
    processed: v.number(),
    updated: v.number(),
    unresolved: v.number(),
    mismatches: v.number(),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
    verifiedAt: v.optional(v.number()),
    lastInputToken: v.optional(v.string()),
    lastIdempotencyKey: v.string(),
    lastRequestFingerprint: v.string(),
    lastResult: v.object({
      processed: v.number(),
      updated: v.number(),
      unresolved: v.number(),
      mismatches: v.number(),
      continueCursor: v.union(v.string(), v.null()),
      isDone: v.boolean(),
    }),
    updatedAt: v.number(),
  }).index(
    "by_environment_and_migrationVersion_and_target_and_mode",
    ["environment", "migrationVersion", "target", "mode"],
  ),
  unifiedJurisdictionRolloutStates: defineTable({
    environment: v.string(),
    migrationVersion: v.literal("jurisdiction_ids_v1"),
    ghanaJurisdictionId: v.optional(v.id("jurisdictions")),
    ghanaProjectionFingerprint: v.optional(v.string()),
    ghanaSeededAt: v.optional(v.number()),
    ghanaSeedLastIdempotencyKey: v.optional(v.string()),
    ghanaSeedLastRequestFingerprint: v.optional(v.string()),
    ghanaSeedLastResult: v.optional(
      v.object({
        jurisdictionId: v.id("jurisdictions"),
        changed: v.boolean(),
      }),
    ),
    legacyObservationGeneration: v.number(),
    legacyObservationStartedAt: v.optional(v.number()),
    legacyLastAcceptedAt: v.optional(v.number()),
    legacyAcceptedSinceStart: v.number(),
    updatedAt: v.number(),
  }).index("by_environment_and_migrationVersion", [
    "environment",
    "migrationVersion",
  ]),
  chatSessions: defineTable({
    userId: v.string(),
    externalId: v.string(),
    title: v.string(),
    lastMessage: v.string(),
    messageCount: v.number(),
    updatedAt: v.number(),
    // ISO 3166-1 alpha-2 jurisdiction code; absent on rows created before
    // multi-country support (treated as the default country).
    country: v.optional(v.string()),
    jurisdictionId: v.optional(v.id("jurisdictions")),
    jurisdictionName: v.optional(v.string()),
    jurisdictionKind: v.optional(jurisdictionKindValidator),
    jurisdictionContract: v.optional(
      v.union(v.literal("legacy"), v.literal("unified")),
    ),
  })
    .index("by_user", ["userId"])
    .index("by_updatedAt", ["updatedAt"])
    .index("by_userId_and_updatedAt", ["userId", "updatedAt"])
    .index("by_user_externalId", ["userId", "externalId"])
    .index("by_jurisdictionId", ["jurisdictionId"]),
  chatCitationClaims: defineTable({
    tokenHash: v.string(),
    ownerBinding: v.string(),
    sessionBinding: v.string(),
    chatSessionId: v.id("chatSessions"),
    jurisdictionId: v.id("jurisdictions"),
    assistantClientIdBinding: v.string(),
    assistantContentBinding: v.string(),
    orderedCitationBinding: v.string(),
    expiresAt: v.number(),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_expiresAt", ["expiresAt"]),
  dailyUsage: defineTable({
    userId: v.string(),
    // UTC day key, e.g. "2026-06-11".
    day: v.string(),
    count: v.number(),
  })
    .index("by_user_day", ["userId", "day"])
    .index("by_day_and_userId", ["day", "userId"]),
  quotaOverrides: defineTable({
    userId: v.string(),
    limit: v.number(),
    startsAt: v.number(),
    expiresAt: v.number(),
    grantedBy: v.string(),
    reason: v.string(),
    active: v.boolean(),
    revokedAt: v.optional(v.number()),
    revokedBy: v.optional(v.string()),
    revokeReason: v.optional(v.string()),
    grantOperationId: v.id("adminOperations"),
    revokeOperationId: v.optional(v.id("adminOperations")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_userId_and_startsAt", ["userId", "startsAt"])
    .index("by_userId_and_expiresAt", ["userId", "expiresAt"])
    .index("by_userId_and_active_and_expiresAt", ["userId", "active", "expiresAt"])
    .index("by_userId_and_active_and_startsAt", ["userId", "active", "startsAt"])
    .index("by_expiresAt", ["expiresAt"])
    .index("by_grantOperationId", ["grantOperationId"])
    .index("by_revokeOperationId", ["revokeOperationId"]),
  researchManifestNonces: defineTable({
    nonceHash: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
  }).index("by_nonceHash", ["nonceHash"]),
  telemetryCorrelations: defineTable({
    tokenHash: v.string(),
    ownerBinding: v.string(),
    sessionBinding: v.string(),
    jurisdictionCode: v.optional(v.string()),
    jurisdictionId: v.optional(v.id("jurisdictions")),
    jurisdictionName: v.optional(v.string()),
    jurisdictionKind: v.optional(jurisdictionKindValidator),
    jurisdictionContract: v.optional(
      v.union(v.literal("legacy"), v.literal("unified")),
    ),
    status: v.union(
      v.literal("issued"),
      v.literal("search_complete"),
      v.literal("chat_claimed"),
      v.literal("finalized"),
    ),
    issuedAt: v.number(),
    expiresAt: v.number(),
    searchProviderStatus: v.optional(
      v.union(v.literal("success"), v.literal("no_result"), v.literal("failure")),
    ),
    searchLatencyMs: v.optional(v.number()),
    resultCount: v.optional(v.number()),
    claimNonceHash: v.optional(v.string()),
    scopeSize: v.optional(v.number()),
    retrievalPlanSize: v.optional(v.number()),
    providerCallCount: v.optional(v.number()),
    fileSearchCallCount: v.optional(v.number()),
    fileSearchStoreCount: v.optional(v.number()),
    fileSearchLatencyMs: v.optional(v.number()),
    evidenceBytes: v.optional(v.number()),
    citationCount: v.optional(v.number()),
    jurisdictionCoverage: v.optional(v.array(v.object({
      ordinal: v.number(),
      relation: v.union(v.literal("selected"), v.literal("geographic_ancestor"), v.literal("organizational_geography")),
      coverage: v.union(v.literal("evidence"), v.literal("no_evidence"), v.literal("unavailable")),
    }))),
    plannerStatus: v.optional(v.union(v.literal("planned"), v.literal("fallback"))),
    plannerLatencyMs: v.optional(v.number()),
    contextDigest: v.optional(v.string()),
    partialCoverage: v.optional(v.boolean()),
    configurationUnavailableCount: v.optional(v.number()),
    supplementaryProviderFailureCount: v.optional(v.number()),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_status_and_expiresAt", ["status", "expiresAt"])
    .index("by_jurisdictionId", ["jurisdictionId"]),
  queryRuns: defineTable({
    correlationId: v.string(),
    day: v.string(),
    jurisdictionCode: v.optional(v.string()),
    jurisdictionId: v.optional(v.id("jurisdictions")),
    jurisdictionName: v.optional(v.string()),
    jurisdictionKind: v.optional(jurisdictionKindValidator),
    outcome: v.union(
      v.literal("success"),
      v.literal("failure"),
      v.literal("aborted"),
    ),
    searchProviderStatus: v.union(
      v.literal("skipped"),
      v.literal("success"),
      v.literal("no_result"),
      v.literal("failure"),
    ),
    generationProviderStatus: v.union(
      v.literal("success"),
      v.literal("failure"),
      v.literal("skipped"),
    ),
    searchLatencyMs: v.number(),
    generationLatencyMs: v.number(),
    totalLatencyMs: v.number(),
    resultCount: v.number(),
    completedAt: v.number(),
    rollupStatus: v.union(v.literal("pending"), v.literal("processed")),
    rolledUpAt: v.optional(v.number()),
    scopeSize: v.optional(v.number()),
    retrievalPlanSize: v.optional(v.number()),
    providerCallCount: v.optional(v.number()),
    fileSearchCallCount: v.optional(v.number()),
    fileSearchStoreCount: v.optional(v.number()),
    fileSearchLatencyMs: v.optional(v.number()),
    evidenceBytes: v.optional(v.number()),
    citationCount: v.optional(v.number()),
    jurisdictionCoverage: v.optional(v.array(v.object({
      ordinal: v.number(),
      relation: v.union(v.literal("selected"), v.literal("geographic_ancestor"), v.literal("organizational_geography")),
      coverage: v.union(v.literal("evidence"), v.literal("no_evidence"), v.literal("unavailable")),
    }))),
    plannerStatus: v.optional(v.union(v.literal("planned"), v.literal("fallback"))),
    plannerLatencyMs: v.optional(v.number()),
    contextDigest: v.optional(v.string()),
    partialCoverage: v.optional(v.boolean()),
    configurationUnavailableCount: v.optional(v.number()),
    supplementaryProviderFailureCount: v.optional(v.number()),
  })
    .index("by_correlationId", ["correlationId"])
    .index("by_rollupStatus_and_completedAt", ["rollupStatus", "completedAt"])
    .index("by_day_and_jurisdictionCode", ["day", "jurisdictionCode"])
    .index("by_jurisdictionId", ["jurisdictionId"]),
  dailyMetrics: defineTable({
    day: v.string(),
    jurisdictionCode: v.optional(v.string()),
    jurisdictionId: v.optional(v.id("jurisdictions")),
    jurisdictionName: v.optional(v.string()),
    jurisdictionKind: v.optional(jurisdictionKindValidator),
    totalQuestions: v.number(),
    successCount: v.number(),
    failureCount: v.number(),
    abortedCount: v.number(),
    providerFailureCount: v.number(),
    noResultCount: v.number(),
    latencyLe250: v.number(),
    latencyLe500: v.number(),
    latencyLe1000: v.number(),
    latencyLe2500: v.number(),
    latencyLe5000: v.number(),
    latencyGt5000: v.number(),
    latencyHistogram: v.optional(v.array(v.number())),
    p50UpperBoundMs: v.number(),
    p95UpperBoundMs: v.number(),
    updatedAt: v.number(),
    scopeSize: v.optional(v.number()),
    retrievalPlanSize: v.optional(v.number()),
    providerCallCount: v.optional(v.number()),
    plannerStatus: v.optional(v.union(v.literal("planned"), v.literal("fallback"))),
    plannerLatencyMs: v.optional(v.number()),
    contextDigest: v.optional(v.string()),
    partialCoverage: v.optional(v.boolean()),
    configurationUnavailableCount: v.optional(v.number()),
    supplementaryProviderFailureCount: v.optional(v.number()),
  })
    .index("by_day", ["day"])
    .index("by_jurisdictionCode_and_day", ["jurisdictionCode", "day"])
    .index("by_jurisdictionCode_and_jurisdictionId_and_day", [
      "jurisdictionCode",
      "jurisdictionId",
      "day",
    ])
    .index("by_day_and_jurisdictionCode", ["day", "jurisdictionCode"])
    .index("by_day_and_jurisdictionId", ["day", "jurisdictionId"])
    .index("by_jurisdictionId_and_day", ["jurisdictionId", "day"])
    .index("by_jurisdictionId", ["jurisdictionId"]),
  messages: defineTable({
    sessionId: v.id("chatSessions"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    clientId: v.optional(v.string()),
    citations: v.optional(v.array(chatCitationValidator)),
    createdAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_session_and_createdAt", ["sessionId", "createdAt"])
    .index("by_session_clientId", ["sessionId", "clientId"]),
});
