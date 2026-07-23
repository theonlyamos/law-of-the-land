import {
  APPLICATION_PERMISSION_METADATA,
  hasRolePermission,
  type AdminRole,
} from "../../../convex/lib/adminPermissions";
import Link from "next/link";
import type { ReactNode } from "react";
import { AdminNav } from "./admin-nav";
import { AdminPermissionProvider } from "./permission-boundary";

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

      <div className="admin-control-plane min-h-screen bg-[oklch(94%_0.015_82)] text-[oklch(24%_0.035_252)]">
        <header className="border-b border-[oklch(78%_0.025_78)] bg-[oklch(97%_0.012_82)] px-4 py-3 sm:px-6 lg:px-8">
          <div className="mx-auto flex max-w-[100rem] items-center justify-between gap-4">
            <Link
              href="/admin"
              className="group flex min-h-11 items-center gap-3 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-700"
            >
              <span
                aria-hidden
                className="grid h-9 w-9 place-items-center border border-[oklch(43%_0.06_70)] bg-[oklch(89%_0.055_79)] font-serif text-lg font-semibold text-[oklch(31%_0.055_64)]"
              >
                L
              </span>
              <span>
                <span className="block text-[0.68rem] font-semibold uppercase tracking-[0.19em] text-[oklch(43%_0.055_252)]">
                  Law of the Land
                </span>
                <span className="block text-sm font-semibold tracking-tight">Administration</span>
              </span>
            </Link>
            <Link
              href="/new"
              className="inline-flex min-h-11 items-center px-3 text-sm font-semibold text-[oklch(35%_0.065_252)] underline decoration-[oklch(60%_0.1_70)] decoration-2 underline-offset-4 hover:text-[oklch(24%_0.055_252)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
            >
              Return to public site
            </Link>
          </div>
        </header>

        <div className="mx-auto grid max-w-[100rem] lg:min-h-[calc(100vh-4.25rem)] lg:grid-cols-[18rem_minmax(0,1fr)]">
          <aside className="border-b border-[oklch(78%_0.025_78)] bg-[oklch(91%_0.02_79)] px-4 py-4 sm:px-6 lg:border-b-0 lg:border-r lg:px-5 lg:py-8">
            <div className="mb-4 hidden border-b border-[oklch(78%_0.025_78)] pb-6 lg:block">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[oklch(45%_0.04_252)]">
                Signed-in authority
              </p>
              <p className="mt-2 text-sm font-semibold text-[oklch(26%_0.04_252)]">{roleSummary}</p>
              <p className="mt-1 truncate text-xs text-[oklch(47%_0.035_252)]" title={currentAdmin.userId}>
                {currentAdmin.userId}
              </p>
            </div>
            <AdminNav roles={currentAdmin.roles} currentPath={currentPath} />
          </aside>

          <main
            id="admin-main-content"
            tabIndex={-1}
            className="min-w-0 px-4 py-8 outline-none sm:px-6 sm:py-10 lg:px-[clamp(2rem,5vw,5rem)] lg:py-14"
          >
            {children}
          </main>
        </div>
      </div>
    </AdminPermissionProvider>
  );
}
