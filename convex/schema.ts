import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  jurisdictions: defineTable({
    code: v.string(),
    name: v.string(),
    slug: v.string(),
    status: v.union(
      v.literal("draft"),
      v.literal("enabled"),
      v.literal("archived"),
    ),
    isDefault: v.boolean(),
    stagingBucketId: v.optional(v.string()),
    productionBucketId: v.optional(v.string()),
    providerSyncState: v.union(
      v.literal("pending"),
      v.literal("synced"),
      v.literal("drifted"),
      v.literal("failed"),
    ),
    createdBy: v.string(),
    updatedBy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_code", ["code"])
    .index("by_slug", ["slug"])
    .index("by_status_and_name", ["status", "name"])
    .index("by_isDefault", ["isDefault"])
    .index("by_isDefault_and_status", ["isDefault", "status"]),
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
      v.literal("uploading"),
      v.literal("staging_processing"),
      v.literal("ready_for_review"),
      v.literal("approved"),
      v.literal("publishing"),
      v.literal("published"),
      v.literal("rejected"),
      v.literal("failed"),
      v.literal("superseded"),
      v.literal("unpublished"),
      v.literal("archived"),
    ),
    groundxStagingDocumentId: v.optional(v.string()),
    groundxStagingProcessId: v.optional(v.string()),
    xrayEvidence: v.optional(v.object({
      status: v.union(
        v.literal("queued"),
        v.literal("processing"),
        v.literal("complete"),
        v.literal("error"),
        v.literal("cancelled"),
      ),
      documentId: v.string(),
      processId: v.string(),
      fileType: v.optional(v.union(
        v.literal("txt"), v.literal("docx"), v.literal("pptx"),
        v.literal("xlsx"), v.literal("pdf"), v.literal("png"),
        v.literal("jpg"), v.literal("csv"), v.literal("tsv"),
        v.literal("json"),
      )),
      fileSize: v.optional(v.number()),
      observedAt: v.number(),
    })),
    groundxProductionDocumentId: v.optional(v.string()),
    groundxProductionProcessId: v.optional(v.string()),
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
    .index("by_resourceId_and_status", ["resourceId", "status"]),
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
    ),
    actorId: v.string(),
    idempotencyKey: v.string(),
    jobId: v.optional(v.id("integrationJobs")),
    expiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_resourceId", ["resourceId"]),
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
    "by_actorId_and_sessionId_and_action_and_targetId_and_idempotencyKey",
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
      v.literal("create_bucket"),
      v.literal("ingest_remote"),
      v.literal("copy_documents"),
      v.literal("delete_documents"),
      v.literal("poll_process"),
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
    callbackTokenHash: v.string(),
    processId: v.optional(v.string()),
    leaseToken: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("waiting_callback"),
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
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_actorId_and_idempotencyKey", ["actorId", "idempotencyKey"])
    .index("by_callbackTokenHash", ["callbackTokenHash"])
    .index("by_processId", ["processId"])
    .index("by_status_and_nextAttemptAt", ["status", "nextAttemptAt"])
    .index("by_targetType_and_targetId", ["targetType", "targetId"]),
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
  ]),
  featureFlags: defineTable({
    key: v.literal("admin_panel"),
    environment: v.string(),
    enabled: v.boolean(),
    updatedAt: v.number(),
    updatedBy: v.optional(v.string()),
  }).index("by_key_and_environment", ["key", "environment"]),
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
  })
    .index("by_user", ["userId"])
    .index("by_updatedAt", ["updatedAt"])
    .index("by_userId_and_updatedAt", ["userId", "updatedAt"])
    .index("by_user_externalId", ["userId", "externalId"]),
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
  messages: defineTable({
    sessionId: v.id("chatSessions"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    clientId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_session_and_createdAt", ["sessionId", "createdAt"])
    .index("by_session_clientId", ["sessionId", "clientId"]),
});
