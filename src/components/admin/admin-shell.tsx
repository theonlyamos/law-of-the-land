import {
  APPLICATION_PERMISSION_METADATA,
  hasRolePermission,
  type AdminRole,
} from "../../../convex/lib/adminPermissions";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import logo from "@/app/logo-transparent.png";
import { AdminNav } from "./admin-nav";
import {
  AdminNavigationProvider,
  AdminNavigationToggle,
  MobileAdminNavigationToggle,
} from "./admin-navigation-state";
import { AdminPermissionProvider } from "./permission-boundary";
import { AdminWorkspace } from "./admin-workspace";

const ROLE_LABELS: Record<AdminRole, string> = {
  super_admin: "Super administrator",
  content_manager: "Content manager",
  content_reviewer: "Content reviewer",
  support_agent: "Support agent",
  billing_manager: "Billing manager",
  auditor: "Auditor",
};

function grantedPermissions(roles: readonly AdminRole[]) {
  return Object.keys(APPLICATION_PERMISSION_METADATA).filter((permission) => {
    const separator = permission.indexOf(":");
    return hasRolePermission(
      roles,
      permission.slice(0, separator),
      permission.slice(separator + 1),
    );
  });
}

export function AdminShell({
  currentAdmin,
  currentPath,
  children,
}: {
  currentAdmin: { userId: string; roles: readonly AdminRole[] };
  currentPath?: string;
  children: ReactNode;
}) {
  const roleSummary = currentAdmin.roles.map((role) => ROLE_LABELS[role]).join(" · ");

  return (
    <AdminPermissionProvider permissions={grantedPermissions(currentAdmin.roles)}>
      <a
        href="#admin-main-content"
        className="fixed left-4 top-3 z-50 -translate-y-20 bg-[oklch(28%_0.055_252)] px-4 py-3 text-sm font-semibold text-[oklch(97%_0.012_82)] shadow-lg transition-transform duration-150 focus:translate-y-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[oklch(65%_0.12_70)]"
      >
        Skip to administration content
      </a>

      <AdminNavigationProvider>
        <div className="admin-control-plane min-h-screen bg-[oklch(94%_0.015_82)] text-[oklch(24%_0.035_252)]">
        <header className="relative z-50 border-b border-[oklch(78%_0.025_78)] bg-[oklch(97%_0.012_82)] px-3 py-2.5 sm:px-6 sm:py-3 lg:px-8">
          <div className="mx-auto grid max-w-[100rem] grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:flex sm:justify-between sm:gap-4">
            <div className="flex min-w-0 items-center gap-2">
              <Link
                href="/admin"
                className="group flex min-h-11 min-w-0 items-center gap-2 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-700 sm:gap-3"
              >
                <Image
                  src={logo}
                  alt="Law of the Land"
                  width={80}
                  height={43}
                  priority
                  className="h-auto w-10 shrink-0 sm:w-12"
                />
                <span className="min-w-0">
                  <span className="hidden text-[0.68rem] font-semibold uppercase tracking-[0.19em] text-[oklch(43%_0.055_252)] sm:block">
                    Law of the Land
                  </span>
                  <span className="block text-sm font-semibold tracking-tight sm:text-sm">Administration</span>
                </span>
              </Link>
              <AdminNavigationToggle />
            </div>
            <Link
              href="/new"
              className="hidden min-h-11 items-center whitespace-nowrap px-3 text-sm font-semibold text-[oklch(35%_0.065_252)] underline decoration-[oklch(60%_0.1_70)] decoration-2 underline-offset-4 hover:text-[oklch(24%_0.055_252)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 md:inline-flex"
            >
              Return to public site
            </Link>
            <MobileAdminNavigationToggle />
          </div>
        </header>

        <AdminWorkspace
          sidebar={
            <>
            <div className="mb-4 hidden border-b border-[oklch(78%_0.025_78)] pb-6 xl:block">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[oklch(45%_0.04_252)]">
                Signed-in authority
              </p>
              <p className="mt-2 text-sm font-semibold text-[oklch(26%_0.04_252)]">{roleSummary}</p>
              <p className="mt-1 truncate text-xs text-[oklch(47%_0.035_252)]" title={currentAdmin.userId}>
                {currentAdmin.userId}
              </p>
            </div>
            <AdminNav roles={currentAdmin.roles} currentPath={currentPath} />
            </>
          }
          mobileMenuFooter={
            <Link
              href="/new"
              className="flex min-h-11 items-center px-3 text-sm font-semibold text-[oklch(35%_0.065_252)] underline decoration-[oklch(60%_0.1_70)] decoration-2 underline-offset-4 hover:text-[oklch(24%_0.055_252)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
            >
              Return to public site
            </Link>
          }
        >
          {children}
        </AdminWorkspace>
        </div>
      </AdminNavigationProvider>
    </AdminPermissionProvider>
  );
}
