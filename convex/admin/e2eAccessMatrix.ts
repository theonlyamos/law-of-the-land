import { ADMIN_ROLES, hasRolePermission, type AdminRole } from "../lib/adminPermissions";

type RoutePermission = readonly [resource: string, action: string];

function protectedRoute(path: string, permissions: readonly RoutePermission[] = []) {
  const allowed = permissions.length === 0
    ? [...ADMIN_ROLES]
    : ADMIN_ROLES.filter((role) => permissions.some(([resource, action]) => hasRolePermission([role], resource, action)));
  return { path, permissions, adminOnly: permissions.length === 0, allowed };
}

export const E2E_PROTECTED_ROUTES = [
  protectedRoute("/admin"),
  protectedRoute("/admin/users", [["user", "read"]]),
  protectedRoute("/admin/conversations", [["conversation", "read_content"]]),
  protectedRoute("/admin/documents", [["resource", "read"], ["resource", "write"]]),
  protectedRoute("/admin/review", [["document", "read"], ["document", "review"]]),
  protectedRoute("/admin/billing", [["billing", "read"]]),
  protectedRoute("/admin/analytics", [["analytics", "read"]]),
  protectedRoute("/admin/operations", [["operations", "read"]]),
  protectedRoute("/admin/incidents", [["operations", "read"]]),
  protectedRoute("/admin/audit", [["audit", "read_masked"]]),
  protectedRoute("/admin/jurisdictions", [["jurisdiction", "read"], ["jurisdiction", "write"]]),
  protectedRoute("/admin/users/:userId", [["user", "read"]]),
  protectedRoute("/admin/conversations/:chatId", [["conversation", "read_content"]]),
  protectedRoute("/admin/documents/:resourceId", [["resource", "read"], ["resource", "write"]]),
  protectedRoute("/admin-recovery", [["user", "set_role"]]),
] as const satisfies ReadonlyArray<{ path: string; permissions: ReadonlyArray<readonly [string, string]>; adminOnly: boolean; allowed: readonly AdminRole[] }>;

export const E2E_PRIVILEGED_FUNCTIONS = [
  { path: "admin/featureFlags:setAdminPanel", resource: "user", action: "set_role", allowed: ["super_admin"], success: "admin_panel_flag_set" },
  { path: "admin/roles:setAdminRoles", resource: "user", action: "set_role", allowed: ["super_admin"], success: "roles_changed" },
  { path: "admin/users:assignRoles", resource: "user", action: "set_role", allowed: ["super_admin"], success: "roles_assign_succeeded" },
  { path: "admin/users:banUser", resource: "user", action: "ban", allowed: ["super_admin"], success: "user_ban_succeeded" },
  { path: "admin/users:unbanUser", resource: "user", action: "ban", allowed: ["super_admin"], success: "user_unban_succeeded" },
  { path: "admin/users:resendVerification", resource: "user", action: "support", allowed: ["super_admin", "support_agent"], success: "verification_completed" },
  { path: "admin/users:revokeSession", resource: "session", action: "revoke", allowed: ["super_admin", "support_agent"], success: "session_revoke_succeeded" },
  { path: "admin/users:revokeAllSessions", resource: "session", action: "revoke", allowed: ["super_admin", "support_agent"], success: "sessions_revoke_all_succeeded" },
  { path: "admin/users:startImpersonation", resource: "user", action: "impersonate", allowed: ["super_admin"], success: "impersonation_authorized" },
  { path: "admin/users:queueUserDeletion", resource: "user", action: "ban", allowed: ["super_admin"], success: "user_deletion_queued" },
  { path: "admin/conversations:createAccessGrant", resource: "conversation", action: "read_content", allowed: ["super_admin", "support_agent"], success: "conversation_grant_created" },
  { path: "admin/exports:queueConversationExport", resource: "conversation", action: "export", allowed: ["super_admin", "support_agent"], success: "conversation_export_ready" },
  { path: "admin/exports:issueConversationExportReference", resource: "conversation", action: "export", allowed: ["super_admin", "support_agent"], success: "export_reference_issued" },
  { path: "admin/documents:generateUploadUrl", resource: "document", action: "write", allowed: ["super_admin", "content_manager"], success: "upload_url_generated" },
  { path: "admin/documents:createDocumentVersion", resource: "document", action: "write", allowed: ["super_admin", "content_manager"], success: "document_version_draft" },
  { path: "admin/resources:createJurisdiction", resource: "jurisdiction", action: "write", allowed: ["super_admin", "content_manager"], success: "jurisdiction_draft_created" },
  { path: "admin/resources:updateJurisdiction", resource: "jurisdiction", action: "write", allowed: ["super_admin", "content_manager"], success: "jurisdiction_updated" },
  { path: "admin/resources:enableJurisdiction", resource: "jurisdiction", action: "write", allowed: ["super_admin", "content_manager"], success: "jurisdiction_enabled" },
  { path: "admin/resources:archiveJurisdiction", resource: "jurisdiction", action: "write", allowed: ["super_admin", "content_manager"], success: "jurisdiction_archived" },
  { path: "admin/resources:createResource", resource: "resource", action: "write", allowed: ["super_admin", "content_manager"], success: "resource_created" },
  { path: "admin/resources:updateResource", resource: "resource", action: "write", allowed: ["super_admin", "content_manager"], success: "resource_updated" },
  { path: "admin/resources:archiveResource", resource: "resource", action: "write", allowed: ["super_admin", "content_manager"], success: "resource_archived" },
  { path: "admin/resources:markResourceRepealed", resource: "resource", action: "write", allowed: ["super_admin", "content_manager"], success: "resource_repealed" },
  { path: "admin/reviews:submitForReview", resource: "document", action: "submit", allowed: ["super_admin", "content_manager"], success: "review_ready" },
  { path: "admin/reviews:approveVersion", resource: "document", action: "review", allowed: ["super_admin", "content_reviewer"], success: "review_approved" },
  { path: "admin/reviews:rejectVersion", resource: "document", action: "review", allowed: ["super_admin", "content_reviewer"], success: "review_rejected" },
  { path: "admin/publication:publishVersion", resource: "document", action: "publish", allowed: ["super_admin", "content_reviewer"], success: "publish_succeeded" },
  { path: "admin/publication:unpublishVersion", resource: "document", action: "publish", allowed: ["super_admin", "content_reviewer"], success: "unpublish_succeeded" },
  { path: "admin/publication:rollbackVersion", resource: "document", action: "rollback", allowed: ["super_admin", "content_reviewer"], success: "rollback_succeeded" },
  { path: "admin/billing:grantQuotaOverride", resource: "quota", action: "write", allowed: ["super_admin", "billing_manager"], success: "quota_override_granted" },
  { path: "admin/billing:revokeQuotaOverride", resource: "quota", action: "write", allowed: ["super_admin", "billing_manager"], success: "quota_override_revoked" },
  { path: "admin/jobs:enqueueJob", resource: "operations", action: "write", allowed: ["super_admin"], success: "job_succeeded" },
  { path: "admin/jobs:retryJob", resource: "operations", action: "retry", allowed: ["super_admin"], success: "job_retry_succeeded" },
  { path: "admin/jobs:cancelJob", resource: "operations", action: "write", allowed: ["super_admin"], success: "job_cancelled" },
  { path: "admin/operations:createIncident", resource: "operations", action: "write", allowed: ["super_admin"], success: "incident_created" },
  { path: "admin/operations:addIncidentNote", resource: "operations", action: "write", allowed: ["super_admin"], success: "incident_note_added" },
  { path: "admin/operations:updateIncident", resource: "operations", action: "write", allowed: ["super_admin"], success: "incident_updated" },
] as const satisfies ReadonlyArray<{ path: string; resource: string; action: string; allowed: readonly AdminRole[]; success: string }>;
