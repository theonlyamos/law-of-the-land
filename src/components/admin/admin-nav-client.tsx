"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  ClipboardCheck,
  CreditCard,
  FileText,
  Landmark,
  LayoutDashboard,
  MessageSquare,
  MonitorSmartphone,
  ScrollText,
  Settings2,
  TriangleAlert,
  UsersRound,
  type LucideIcon,
} from "lucide-react";

export type AdminNavGroup = {
  label: string;
  items: Array<{ label: string; href: string }>;
};

const NAV_ITEM_ICONS: Record<string, LucideIcon> = {
  "/admin": LayoutDashboard,
  "/admin/users": UsersRound,
  "/admin/sessions": MonitorSmartphone,
  "/admin/conversations": MessageSquare,
  "/admin/jurisdictions": Landmark,
  "/admin/documents": FileText,
  "/admin/review": ClipboardCheck,
  "/admin/billing": CreditCard,
  "/admin/analytics": BarChart3,
  "/admin/operations": Settings2,
  "/admin/incidents": TriangleAlert,
  "/admin/audit": ScrollText,
};

export function AdminNavClient({
  groups,
  currentPath,
}: {
  groups: readonly AdminNavGroup[];
  currentPath?: string;
}) {
  const pathname = usePathname() ?? currentPath;

  return (
    <nav
      aria-label="Administration"
      className="admin-nav grid gap-5 md:block md:space-y-7"
    >
      {groups.map((group) => (
        <section
          key={group.label}
          className="min-w-0 md:shrink"
          aria-labelledby={`admin-nav-${group.label.toLowerCase().replaceAll(" ", "-")}`}
        >
          <h2
            id={`admin-nav-${group.label.toLowerCase().replaceAll(" ", "-")}`}
            className="admin-nav-heading px-3 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500"
          >
            {group.label}
          </h2>
          <ul className="mt-2 grid gap-1 md:block md:space-y-1">
            {group.items.map((item) => (
              <li key={item.href}>
                {(() => {
                  const Icon = NAV_ITEM_ICONS[item.href] ?? LayoutDashboard;

                  return (
                    <Link
                      href={item.href}
                      aria-label={item.label}
                      aria-current={pathname === item.href ? "page" : undefined}
                      className="admin-nav-link flex min-h-11 items-center gap-3 whitespace-nowrap border-b-2 border-transparent px-3 text-sm font-medium text-slate-700 transition-colors duration-150 hover:bg-slate-200/60 hover:text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 aria-[current=page]:border-amber-700 aria-[current=page]:bg-white/70 aria-[current=page]:text-slate-950 md:rounded-md md:border-b-0 md:border-l-2"
                    >
                      <Icon aria-hidden="true" className="h-5 w-5 shrink-0" />
                      <span className="admin-nav-label">{item.label}</span>
                    </Link>
                  );
                })()}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}
