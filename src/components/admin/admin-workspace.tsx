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
      className={`mx-auto grid max-w-[100rem] md:min-h-[calc(100vh-4.25rem)] ${
        isCollapsed
          ? "md:grid-cols-1"
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
            ? "fixed inset-x-0 top-16 z-40 block max-h-[calc(100dvh-4rem)] overflow-y-auto shadow-xl"
            : "hidden"
        } border-b border-[oklch(78%_0.025_78)] bg-[oklch(91%_0.02_79)] px-4 py-4 sm:px-6 md:static md:block md:max-h-none md:overflow-visible md:border-b-0 md:border-r md:px-4 md:py-6 md:shadow-none xl:px-5 xl:py-8 ${
          isCollapsed ? "md:hidden" : ""
        }`}
      >
        {sidebar}
        {mobileMenuFooter ? (
          <div className="mt-6 border-t border-[oklch(78%_0.025_78)] pt-4 md:hidden">
            {mobileMenuFooter}
          </div>
        ) : null}
      </aside>

      <main
        id="admin-main-content"
        tabIndex={-1}
        className="min-w-0 px-4 py-8 outline-none sm:px-6 sm:py-10 xl:px-[clamp(2rem,5vw,5rem)] xl:py-14"
      >
        {children}
      </main>
    </div>
  );
}
