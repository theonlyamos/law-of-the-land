"use client";

import type { ReactNode } from "react";
import { PanelLeftOpen } from "lucide-react";
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
  const { isCollapsed, isMobileMenuOpen, setIsCollapsed, setIsMobileMenuOpen } =
    useAdminNavigation();

  return (
    <div
      className={`grid h-dvh min-h-0 w-full overflow-hidden ${
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
            ? "fixed inset-0 z-40 block h-dvh overflow-y-auto shadow-xl"
            : "hidden"
        } border-b border-[oklch(78%_0.025_78)] bg-[oklch(91%_0.02_79)] px-4 pb-6 pt-16 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:px-6 md:static md:block md:h-dvh md:max-h-none md:overflow-y-auto md:border-b-0 md:border-r md:px-4 md:py-6 md:shadow-none xl:px-5 xl:py-8 ${
          isCollapsed ? "md:hidden" : ""
        }`}
      >
        {sidebar}
        {mobileMenuFooter ? (
          <div className="mt-6 border-t border-[oklch(78%_0.025_78)] pt-4">
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

      {isCollapsed ? (
        <button
          type="button"
          aria-controls="admin-sidebar"
          aria-expanded="false"
          aria-label="Expand administration navigation"
          onClick={() => setIsCollapsed(false)}
          className="fixed left-0 top-4 z-50 hidden min-h-11 items-center justify-center rounded-r-md border border-l-0 border-[oklch(61%_0.035_252)] bg-[oklch(97%_0.012_82)] px-3 text-sm font-semibold text-[oklch(31%_0.055_252)] shadow-md transition-colors hover:bg-[oklch(89%_0.025_79)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 [&>span:first-child]:hidden md:inline-flex"
        >
          <span aria-hidden className="text-lg leading-none">â€º</span>
          <PanelLeftOpen aria-hidden="true" className="h-5 w-5" />
          <span className="sr-only">Navigation</span>
        </button>
      ) : null}
    </div>
  );
}
