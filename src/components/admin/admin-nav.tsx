import {
  hasRolePermission,
  type AdminRole,
} from "../../../convex/lib/adminPermissions";
import { AdminNavClient, type AdminNavGroup } from "./admin-nav-client";

type NavItem = {
  label: string;
  href: string;
  permissions?: ReadonlyArray<readonly [resource: string, action: string]>;
};

const NAV_GROUPS: ReadonlyArray<{
  label: string;
  items: readonly NavItem[];
}> = [
  {
    label: "Workspace",
    items: [{ label: "Overview", href: "/admin" }],
  },
  {
    label: "People",
    items: [
      { label: "Users", href: "/admin/users", permissions: [["user", "read"]] },
      { label: "Sessions", href: "/admin/sessions", permissions: [["session", "revoke"]] },
      {
        label: "Conversations",
        href: "/admin/conversations",
        permissions: [["conversation", "read_content"]],
      },
    ],
  },
  {
    label: "Legal library",
    items: [
      {
        label: "Jurisdictions",
        href: "/admin/jurisdictions",
        permissions: [
          ["jurisdiction", "read"],
          ["jurisdiction", "write"],
        ],
      },
      { label: "Documents", href: "/admin/documents", permissions: [["document", "read"]] },
      {
        label: "Review queue",
        href: "/admin/review",
        permissions: [["document", "review"]],
      },
    ],
  },
  {
    label: "Control",
    items: [
      { label: "Billing", href: "/admin/billing", permissions: [["billing", "read"]] },
      { label: "Analytics", href: "/admin/analytics", permissions: [["analytics", "read"]] },
      { label: "Operations", href: "/admin/operations", permissions: [["operations", "read"]] },
      { label: "Incidents", href: "/admin/incidents", permissions: [["operations", "read"]] },
      { label: "Audit", href: "/admin/audit", permissions: [["audit", "read_masked"]] },
    ],
  },
];

function canSeeItem(roles: readonly AdminRole[], item: NavItem): boolean {
  return (
    !item.permissions ||
    item.permissions.some(([resource, action]) => hasRolePermission(roles, resource, action))
  );
}

export function AdminNav({
  roles,
  currentPath,
}: {
  roles: readonly AdminRole[];
  currentPath?: string;
}) {
  const groups: AdminNavGroup[] = [];

  for (const group of NAV_GROUPS) {
    const items = group.items
      .filter((item) => canSeeItem(roles, item))
      .map(({ label, href }) => ({ label, href }));
    if (items.length > 0) groups.push({ label: group.label, items });
  }

  return <AdminNavClient groups={groups} currentPath={currentPath} />;
}
