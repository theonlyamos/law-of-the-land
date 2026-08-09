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

/**
 * The complete application permission universe. Access checks, impersonation
 * policy, and Better Auth role statements are all derived from this metadata.
 */
export const APPLICATION_PERMISSION_METADATA = {
  "jurisdiction:read": { access: "read" },
  "jurisdiction:write": { access: "write" },
  "organization:read": { access: "read" },
  "organization:write": { access: "write" },
  "resource:read": { access: "read" },
  "resource:write": { access: "write" },
  "document:read": { access: "read" },
  "document:write": { access: "write" },
  "document:submit": { access: "write" },
  "document:review": { access: "write" },
  "document:publish": { access: "write" },
  "document:rollback": { access: "write" },
  "user:read": { access: "read" },
  "user:support": { access: "write" },
  "user:set_role": { access: "write" },
  "user:ban": { access: "write" },
  "user:impersonate": { access: "write" },
  "session:revoke": { access: "write" },
  "conversation:read_content": { access: "read" },
  "conversation:export": { access: "write" },
  "billing:read": { access: "read" },
  "billing:write": { access: "write" },
  "quota:write": { access: "write" },
  "analytics:read": { access: "read" },
  "audit:read_masked": { access: "read" },
  "operations:read": { access: "read" },
  "operations:write": { access: "write" },
  "operations:retry": { access: "write" },
} as const;

export type ApplicationPermission = keyof typeof APPLICATION_PERMISSION_METADATA;
export type PermissionAccess = "read" | "write";

export const ADMIN_PERMISSIONS = {
  super_admin: ["*:*"] as const,
  content_manager: [
    "jurisdiction:write",
    "organization:write",
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
    "organization:read",
    "resource:read",
    "document:read",
    "user:read",
    "analytics:read",
    "audit:read_masked",
    "operations:read",
  ] as const,
} satisfies Record<
  AdminRole,
  readonly (ApplicationPermission | "*:*")[]
>;

const adminRoleSet = new Set<string>(ADMIN_ROLES);
const applicationPermissionSet = new Set<string>(
  Object.keys(APPLICATION_PERMISSION_METADATA),
);

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

export function isApplicationPermission(
  value: string,
): value is ApplicationPermission {
  return applicationPermissionSet.has(value);
}

export function getPermissionAccess(
  resource: string,
  action: string,
): PermissionAccess | undefined {
  const permission = `${resource}:${action}`;
  if (!isApplicationPermission(permission)) {
    return undefined;
  }
  return APPLICATION_PERMISSION_METADATA[permission].access;
}

export function hasRolePermission(
  roles: readonly string[],
  resource: string,
  action: string,
): boolean {
  const requestedPermission = `${resource}:${action}`;
  if (!isApplicationPermission(requestedPermission)) {
    return false;
  }

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

function statementsFromPermissions(
  permissions: readonly ApplicationPermission[],
): Record<string, string[]> {
  const statements: Record<string, string[]> = {};
  for (const permission of permissions) {
    const separator = permission.indexOf(":");
    const resource = permission.slice(0, separator);
    const action = permission.slice(separator + 1);
    statements[resource] ??= [];
    statements[resource].push(action);
  }
  return statements;
}

const allApplicationPermissions = Object.keys(
  APPLICATION_PERMISSION_METADATA,
) as ApplicationPermission[];
const applicationStatements = statementsFromPermissions(
  allApplicationPermissions,
);

/**
 * Better Auth's Admin plugin adds its own user/session actions. Its mutating
 * endpoints remain blocked at the auth boundary; application statements come
 * exclusively from APPLICATION_PERMISSION_METADATA.
 */
export const adminAccessControl = createAccessControl({
  ...applicationStatements,
  user: [
    ...new Set([
      ...defaultStatements.user,
      ...(applicationStatements.user ?? []),
    ]),
  ],
  session: [
    ...new Set([
      ...defaultStatements.session,
      ...(applicationStatements.session ?? []),
    ]),
  ],
});

function roleStatementsFromRegistry(
  role: AdminRole,
): Record<string, string[]> {
  const permissions = ADMIN_PERMISSIONS[role].includes("*:*" as never)
    ? allApplicationPermissions
    : ([...ADMIN_PERMISSIONS[role]] as ApplicationPermission[]);
  const statements = statementsFromPermissions(permissions);

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
