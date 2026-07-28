import { describe, expect, it } from "vitest";
import { ADMIN_ROLES, hasRolePermission } from "../lib/adminPermissions";
import { E2E_PRIVILEGED_FUNCTIONS, E2E_PROTECTED_ROUTES } from "./e2eAccessMatrix";

describe("admin E2E authorization matrix", () => {
  const publicPrivilegedPaths = [
    "admin/featureFlags:setAdminPanel",
    "admin/roles:setAdminRoles",
    "admin/users:assignRoles",
    "admin/users:banUser",
    "admin/users:unbanUser",
    "admin/users:resendVerification",
    "admin/users:revokeSession",
    "admin/users:revokeAllSessions",
    "admin/users:startImpersonation",
    "admin/users:queueUserDeletion",
    "admin/conversations:createAccessGrant",
    "admin/exports:queueConversationExport",
    "admin/exports:issueConversationExportReference",
    "admin/documents:generateUploadUrl",
    "admin/documents:createDocumentVersion",
    "admin/resources:createJurisdiction",
    "admin/resources:updateJurisdiction",
    "admin/resources:enableJurisdiction",
    "admin/resources:archiveJurisdiction",
    "admin/resources:createResource",
    "admin/resources:updateResource",
    "admin/resources:archiveResource",
    "admin/resources:markResourceRepealed",
    "admin/reviews:submitForReview",
    "admin/reviews:approveVersion",
    "admin/reviews:rejectVersion",
    "admin/publication:publishVersion",
    "admin/publication:unpublishVersion",
    "admin/publication:rollbackVersion",
    "admin/billing:grantQuotaOverride",
    "admin/billing:revokeQuotaOverride",
    "admin/jobs:enqueueJob",
    "admin/jobs:retryJob",
    "admin/jobs:cancelJob",
    "admin/operations:createIncident",
    "admin/operations:addIncidentNote",
    "admin/operations:updateIncident",
  ];

  it("covers every fixed role against every protected route and privileged function", () => {
    const entries = [...E2E_PROTECTED_ROUTES, ...E2E_PRIVILEGED_FUNCTIONS];
    expect(entries.length).toBeGreaterThanOrEqual(24);
    for (const entry of entries) {
      for (const role of ADMIN_ROLES) {
        const granted = "permissions" in entry
          ? (entry.adminOnly || entry.permissions.some(([resource, action]) => hasRolePermission([role], resource, action)))
          : hasRolePermission([role], entry.resource, entry.action);
        expect(
          granted,
          `${role} -> ${"path" in entry ? entry.path : "unknown"}`,
        ).toBe(entry.allowed.includes(role as never));
      }
      const normalGranted = "permissions" in entry
        ? false
        : hasRolePermission(["user"], entry.resource, entry.action);
      expect(normalGranted).toBe(false);
    }
  });

  it("keeps the canonical privileged mutation surface at exactly 37 operations", () => {
    expect(E2E_PRIVILEGED_FUNCTIONS).toHaveLength(37);
  });

  it("contains no duplicate route or function entries and includes every required domain", () => {
    expect(new Set(E2E_PROTECTED_ROUTES.map((entry) => entry.path)).size).toBe(E2E_PROTECTED_ROUTES.length);
    expect(new Set(E2E_PRIVILEGED_FUNCTIONS.map((entry) => entry.path)).size).toBe(E2E_PRIVILEGED_FUNCTIONS.length);
    expect(new Set(E2E_PRIVILEGED_FUNCTIONS.map((entry) => entry.path.split("/")[1].split(":")[0]))).toEqual(
      new Set(["featureFlags", "roles", "users", "conversations", "exports", "documents", "resources", "reviews", "publication", "billing", "jobs", "operations"]),
    );
  });

  it("enumerates the exact public privileged mutation surface", () => {
    expect(E2E_PRIVILEGED_FUNCTIONS.map((entry) => entry.path)).toEqual(publicPrivilegedPaths);
  });

  it("declares an operation-specific authoritative success contract for every mutation", () => {
    for (const entry of E2E_PRIVILEGED_FUNCTIONS) {
      expect(entry, entry.path).toHaveProperty("success");
      expect((entry as { success?: unknown }).success, entry.path).not.toBe("authorization_only");
    }
  });

  it("matches the canonical page gates for the overview and document detail", () => {
    expect(E2E_PROTECTED_ROUTES.find((entry) => entry.path === "/admin")?.allowed).toEqual(ADMIN_ROLES);
    expect(E2E_PROTECTED_ROUTES.find((entry) => entry.path === "/admin/documents/:resourceId")).toMatchObject({
      permissions: [["resource", "read"], ["resource", "write"]],
      allowed: ["super_admin", "content_manager", "auditor"],
    });
    expect(E2E_PROTECTED_ROUTES.find((entry) => entry.path === "/admin-recovery")).toMatchObject({
      permissions: [["user", "set_role"]],
      allowed: ["super_admin"],
    });
  });
});
