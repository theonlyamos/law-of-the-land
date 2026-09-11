"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, Library, Users, Settings, Home } from "lucide-react";
import { AdminWorkspace } from "@/components/admin/admin-workspace";
import {
  AdminNavigationProvider,
  AdminNavigationToggle,
  MobileAdminNavigationToggle,
} from "@/components/admin/admin-navigation-state";
export function OrganizationShell({
  organizationId,
  name = "Organizations",
  archived = false,
  children,
}: {
  organizationId?: string;
  name?: string;
  archived?: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname(),
    base = `/organizations/${organizationId}`;
  const links = [
    { href: "/organizations", label: "Your organizations", Icon: Building2 },
    ...(organizationId && !archived
      ? [
          {
            href: `${base}/jurisdictions`,
            label: "Jurisdictions",
            Icon: Library,
          },
          { href: `${base}/members`, label: "Members", Icon: Users },
        ]
      : []),
    ...(organizationId
      ? [{ href: `${base}/settings`, label: "Settings", Icon: Settings }]
      : []),
    { href: "/new", label: "Back to chat", Icon: Home },
  ];
  return (
    <div className="min-h-dvh bg-[oklch(97%_0.012_82)] text-[oklch(23%_0.05_252)]">
      <AdminNavigationProvider>
        <a
          href="#admin-main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-white focus:p-3"
        >
          Skip to content
        </a>
        <MobileAdminNavigationToggle label="organization" />
        <AdminWorkspace
          sidebar={
            <>
              <Link
                href="/"
                aria-label="Law of the Land home"
                className="admin-sidebar-brand flex min-h-11 items-center gap-3 font-semibold"
              >
                <Library aria-hidden className="size-6 shrink-0" />
                <span className="admin-sidebar-expanded">Law of the Land</span>
              </Link>
              <div className="admin-sidebar-expanded my-8">
                <p className="text-xs uppercase tracking-widest">
                  Organization workspace
                </p>
                <p className="mt-2 break-words text-xl font-semibold">{name}</p>
              </div>
              <nav className="admin-nav space-y-2" aria-label="Organization">
                {links.map(({ href, label, Icon }) => (
                  <Link
                    key={href}
                    href={href}
                    aria-label={label}
                    title={label}
                    aria-current={
                      pathname === href ||
                      (href !== "/organizations" &&
                        pathname.startsWith(`${href}/`))
                        ? "page"
                        : undefined
                    }
                    className="admin-nav-link flex min-h-11 items-center gap-3 border-l-2 border-transparent px-3 text-sm font-medium hover:bg-slate-200/60 aria-[current=page]:border-amber-700 aria-[current=page]:bg-slate-200/60 focus-visible:outline-2 focus-visible:outline-amber-700"
                  >
                    <Icon aria-hidden className="size-5 shrink-0" />
                    <span className="admin-nav-label">{label}</span>
                  </Link>
                ))}
              </nav>
              <div className="mt-8">
                <AdminNavigationToggle label="organization" />
              </div>
            </>
          }
        >
          {children}
        </AdminWorkspace>
      </AdminNavigationProvider>
    </div>
  );
}
