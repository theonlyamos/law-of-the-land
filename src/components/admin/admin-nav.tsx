import {
  hasRolePermission,
  type AdminRole,
} from "../../../convex/lib/adminPermissions";
import Link from "next/link";

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
  return (
    <nav
      aria-label="Administration"
      className="flex gap-6 overflow-x-auto pb-2 [scrollbar-width:thin] lg:block lg:space-y-7 lg:overflow-visible lg:pb-0"
    >
      {NAV_GROUPS.map((group) => {
        const items = group.items.filter((item) => canSeeItem(roles, item));
        if (items.length === 0) return null;

        return (
          <section
            key={group.label}
            className="shrink-0 lg:shrink"
            aria-labelledby={`admin-nav-${group.label.toLowerCase().replaceAll(" ", "-")}`}
          >
            <h2
              id={`admin-nav-${group.label.toLowerCase().replaceAll(" ", "-")}`}
              className="sr-only px-3 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500 lg:not-sr-only"
            >
              {group.label}
            </h2>
            <ul className="flex gap-1 lg:mt-2 lg:block lg:space-y-1">
              {items.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={currentPath === item.href ? "page" : undefined}
                    className="flex min-h-11 items-center whitespace-nowrap border-b-2 border-transparent px-3 text-sm font-medium text-slate-700 transition-colors duration-150 hover:bg-slate-200/60 hover:text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 aria-[current=page]:border-amber-700 aria-[current=page]:bg-white/70 aria-[current=page]:text-slate-950 lg:rounded-md lg:border-b-0 lg:border-l-2"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </nav>
  );
}
