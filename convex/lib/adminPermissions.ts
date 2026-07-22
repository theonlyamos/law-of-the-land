import { createAccessControl, type Role } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
} from "better-auth/plugins/admin/access";

export const ADMIN_ROLES = [
  "super_admin",
  "content_manager",
  "content_reviewer",
  "support_agent",
  "billing_manager",
  "auditor",
] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

export const ADMIN_PERMISSIONS = {
  super_admin: ["*:*"] as const,
  content_manager: [
    "jurisdiction:write",
    "resource:write",
    "document:write",
    "document:submit",
    "document:read",
  ] as const,
  content_reviewer: [
    "document:read",
    "document:review",
    "document:publish",
    "document:rollback",
  ] as const,
  support_agent: [
    "user:read",
    "user:support",
    "session:revoke",
    "conversation:read_content",
    "conversation:export",
  ] as const,
  billing_manager: [
    "user:read",
    "billing:read",
    "billing:write",
    "quota:write",
    "analytics:read",
  ] as const,
  auditor: [
    "jurisdiction:read",
    "resource:read",
    "document:read",
    "analytics:read",
    "audit:read_masked",
    "operations:read",
  ] as const,
} satisfies Record<AdminRole, readonly string[]>;

const adminRoleSet = new Set<string>(ADMIN_ROLES);

export function isAdminRole(value: string): value is AdminRole {
  return adminRoleSet.has(value);
}

export function parseAdminRoles(value: unknown): AdminRole[] {
  if (typeof value !== "string") {
    return [];
  }

  return [...new Set(value.split(",").map((role) => role.trim()))].filter(
    isAdminRole,
  );
}

export function hasRolePermission(
  roles: readonly string[],
  resource: string,
  action: string,
): boolean {
  const requestedPermission = `${resource}:${action}`;

  return roles.some((role) => {
    if (!isAdminRole(role)) {
      return false;
    }

    const permissions = ADMIN_PERMISSIONS[role] as readonly string[];
    return (
      permissions.includes("*:*") || permissions.includes(requestedPermission)
    );
  });
}

/**
 * Better Auth's Admin plugin uses its own user/session action names. They are
 * included in the access-control statement so the plugin can type and inspect
 * our fixed roles. Mutating Admin endpoints are still blocked at the auth
 * boundary and routed through guarded Convex mutations.
 */
export const adminAccessControl = createAccessControl({
  user: [...defaultStatements.user, "read", "support"],
  session: [...defaultStatements.session],
  jurisdiction: ["read", "write"],
  resource: ["read", "write"],
  document: ["read", "write", "submit", "review", "publish", "rollback"],
  conversation: ["read_content", "export"],
  billing: ["read", "write"],
  quota: ["write"],
  analytics: ["read"],
  audit: ["read_masked"],
  operations: ["read"],
} as const);

const allKnownApplicationPermissions = [
  ...new Set(
    Object.values(ADMIN_PERMISSIONS)
      .flatMap((permissions) => permissions)
      .filter((permission) => permission !== "*:*"),
  ),
];

function roleStatementsFromRegistry(
  role: AdminRole,
): Record<string, string[]> {
  const statements: Record<string, string[]> = {};
  const permissions = ADMIN_PERMISSIONS[role].includes("*:*" as never)
    ? allKnownApplicationPermissions
    : [...ADMIN_PERMISSIONS[role]];

  for (const permission of permissions) {
    const separator = permission.indexOf(":");
    const resource = permission.slice(0, separator);
    const action = permission.slice(separator + 1);
    statements[resource] ??= [];
    statements[resource].push(action);
  }

  if (role === "super_admin") {
    for (const [resource, actions] of Object.entries(adminAc.statements)) {
      statements[resource] = [
        ...new Set([...(statements[resource] ?? []), ...actions]),
      ];
    }
  }

  return statements;
}

function createBetterAuthRole(role: AdminRole): Role {
  return adminAccessControl.newRole(roleStatementsFromRegistry(role) as never);
}

export const betterAuthAdminRoles = {
  user: adminAccessControl.newRole({}),
  super_admin: createBetterAuthRole("super_admin"),
  content_manager: createBetterAuthRole("content_manager"),
  content_reviewer: createBetterAuthRole("content_reviewer"),
  support_agent: createBetterAuthRole("support_agent"),
  billing_manager: createBetterAuthRole("billing_manager"),
  auditor: createBetterAuthRole("auditor"),
} satisfies Record<AdminRole | "user", Role>;
