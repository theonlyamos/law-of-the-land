"use client";

import type { ReactNode } from "react";
import { useAdminNavigation } from "./admin-navigation-state";

export function AdminWorkspace({
  sidebar,
  mobileMenuFooter,
  children,
}: {
  sidebar: ReactNode;
  mobileMenuFooter?: ReactNode;
  children: ReactNode;
}) {
  const { isCollapsed, isMobileMenuOpen, setIsMobileMenuOpen } = useAdminNavigation();

  return (
    <div
      className={`grid h-dvh min-h-0 w-full overflow-hidden ${
        isCollapsed
          ? "md:grid-cols-[4rem_minmax(0,1fr)]"
          : "md:grid-cols-[14rem_minmax(0,1fr)] xl:grid-cols-[18rem_minmax(0,1fr)]"
      }`}
    >
      <aside
        id="admin-sidebar"
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest("a")) {
            setIsMobileMenuOpen(false);
          }
        }}
        className={`${
          isMobileMenuOpen
            ? "fixed inset-0 z-40 block h-dvh overflow-y-auto shadow-xl"
            : "hidden"
        } border-b border-[oklch(78%_0.025_78)] bg-[oklch(91%_0.02_79)] px-4 pb-6 pt-16 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:px-6 md:static md:block md:h-dvh md:max-h-none md:overflow-y-auto md:border-b-0 md:border-r md:px-4 md:py-6 md:shadow-none xl:px-5 xl:py-8 ${
          isCollapsed
            ? "md:px-2 md:[&_.admin-sidebar-brand]:justify-center md:[&_.admin-sidebar-collapse-control]:justify-center md:[&_.admin-sidebar-expanded]:hidden md:[&_.admin-nav]:space-y-3 md:[&_.admin-nav-heading]:hidden md:[&_.admin-nav-label]:hidden md:[&_.admin-nav-link]:justify-center md:[&_.admin-nav-link]:px-2"
            : ""
        }`}
      >
        {sidebar}
        {mobileMenuFooter ? (
          <div className="admin-sidebar-expanded mt-6 border-t border-[oklch(78%_0.025_78)] pt-4">
            {mobileMenuFooter}
          </div>
        ) : null}
      </aside>

      <main
        id="admin-main-content"
        tabIndex={-1}
        className="h-dvh min-w-0 overflow-y-auto px-4 py-8 outline-none sm:px-6 sm:py-10 xl:px-[clamp(2rem,5vw,5rem)] xl:py-14"
      >
        {children}
      </main>
    </div>
  );
}
