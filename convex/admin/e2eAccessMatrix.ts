import type { AdminRole } from "../lib/adminPermissions";

export const E2E_PROTECTED_ROUTES = [
  { path: "/admin/users", permissions: [["user", "read"]], allowed: ["super_admin", "support_agent", "billing_manager", "auditor"] },
  { path: "/admin/conversations", permissions: [["conversation", "read_content"]], allowed: ["super_admin", "support_agent"] },
  { path: "/admin/documents", permissions: [["resource", "read"], ["resource", "write"]], allowed: ["super_admin", "content_manager", "auditor"] },
  { path: "/admin/review", permissions: [["document", "read"], ["document", "review"]], allowed: ["super_admin", "content_manager", "content_reviewer", "auditor"] },
  { path: "/admin/billing", permissions: [["billing", "read"]], allowed: ["super_admin", "billing_manager"] },
  { path: "/admin/analytics", permissions: [["analytics", "read"]], allowed: ["super_admin", "billing_manager", "auditor"] },
  { path: "/admin/operations", permissions: [["operations", "read"]], allowed: ["super_admin", "auditor"] },
  { path: "/admin/incidents", permissions: [["operations", "read"]], allowed: ["super_admin", "auditor"] },
  { path: "/admin/audit", permissions: [["audit", "read_masked"]], allowed: ["super_admin", "auditor"] },
  { path: "/admin/jurisdictions", permissions: [["jurisdiction", "read"], ["jurisdiction", "write"]], allowed: ["super_admin", "content_manager", "auditor"] },
] as const satisfies ReadonlyArray<{ path: string; permissions: ReadonlyArray<readonly [string, string]>; allowed: readonly AdminRole[] }>;

export const E2E_PRIVILEGED_FUNCTIONS = [
  { path: "admin/users:assignRoles", resource: "user", action: "set_role", allowed: ["super_admin"] },
  { path: "admin/users:banUser", resource: "user", action: "ban", allowed: ["super_admin"] },
  { path: "admin/users:resendVerification", resource: "user", action: "support", allowed: ["super_admin", "support_agent"] },
  { path: "admin/users:revokeSession", resource: "session", action: "revoke", allowed: ["super_admin", "support_agent"] },
  { path: "admin/conversations:createAccessGrant", resource: "conversation", action: "read_content", allowed: ["super_admin", "support_agent"] },
  { path: "admin/exports:queueConversationExport", resource: "conversation", action: "export", allowed: ["super_admin", "support_agent"] },
  { path: "admin/resources:createResource", resource: "resource", action: "write", allowed: ["super_admin", "content_manager"] },
  { path: "admin/reviews:approveVersion", resource: "document", action: "review", allowed: ["super_admin", "content_reviewer"] },
  { path: "admin/publication:publishVersion", resource: "document", action: "publish", allowed: ["super_admin", "content_reviewer"] },
  { path: "admin/publication:unpublishVersion", resource: "document", action: "publish", allowed: ["super_admin", "content_reviewer"] },
  { path: "admin/publication:rollbackVersion", resource: "document", action: "rollback", allowed: ["super_admin", "content_reviewer"] },
  { path: "admin/billing:grantQuotaOverride", resource: "quota", action: "write", allowed: ["super_admin", "billing_manager"] },
  { path: "admin/jobs:retryJob", resource: "operations", action: "retry", allowed: ["super_admin"] },
  { path: "admin/operations:createIncident", resource: "operations", action: "write", allowed: ["super_admin"] },
] as const satisfies ReadonlyArray<{ path: string; resource: string; action: string; allowed: readonly AdminRole[] }>;
