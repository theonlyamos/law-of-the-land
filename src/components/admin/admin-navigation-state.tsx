"use client";

import {
  createContext,
  useContext,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

type AdminNavigationState = {
  isCollapsed: boolean;
  setIsCollapsed: Dispatch<SetStateAction<boolean>>;
  isMobileMenuOpen: boolean;
  setIsMobileMenuOpen: Dispatch<SetStateAction<boolean>>;
};

const AdminNavigationContext = createContext<AdminNavigationState | null>(null);

export function AdminNavigationProvider({ children }: { children: ReactNode }) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  return (
    <AdminNavigationContext.Provider
      value={{
        isCollapsed,
        setIsCollapsed,
        isMobileMenuOpen,
        setIsMobileMenuOpen,
      }}
    >
      {children}
    </AdminNavigationContext.Provider>
  );
}

export function useAdminNavigation() {
  const state = useContext(AdminNavigationContext);
  if (!state) throw new Error("Admin navigation controls require their provider.");
  return state;
}

export function AdminNavigationToggle() {
  const { isCollapsed, setIsCollapsed } = useAdminNavigation();

  return (
    <button
      type="button"
      aria-controls="admin-sidebar"
      aria-expanded={!isCollapsed}
      aria-label={
        isCollapsed
          ? "Expand administration navigation"
          : "Collapse administration navigation"
      }
      onClick={() => setIsCollapsed((value) => !value)}
      className="admin-nav-link hidden min-h-11 w-full items-center justify-start gap-3 whitespace-nowrap border-b-2 border-transparent px-3 text-sm font-medium text-slate-700 transition-colors duration-150 hover:bg-slate-200/60 hover:text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 md:flex md:rounded-md md:border-b-0 md:border-l-2"
    >
      {isCollapsed ? (
        <PanelLeftOpen aria-hidden="true" className="h-5 w-5" />
      ) : (
        <PanelLeftClose aria-hidden="true" className="h-5 w-5" />
      )}
      <span aria-hidden className="hidden text-lg leading-none">
        {isCollapsed ? "›" : "‹"}
      </span>
      <span className="admin-sidebar-expanded">
        {isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      </span>
      <span className="sr-only">Navigation</span>
    </button>
  );
}

export function MobileAdminNavigationToggle() {
  const { isMobileMenuOpen, setIsMobileMenuOpen } = useAdminNavigation();

  return (
    <button
      type="button"
      aria-controls="admin-sidebar"
      aria-expanded={isMobileMenuOpen}
      aria-label={
        isMobileMenuOpen ? "Close administration menu" : "Open administration menu"
      }
      onClick={() => setIsMobileMenuOpen((value) => !value)}
      className="fixed right-4 top-0 z-50 inline-flex min-h-12 min-w-12 items-center justify-center rounded-b-lg border border-t-0 border-[oklch(61%_0.035_252)] bg-[oklch(97%_0.012_82)] text-[oklch(31%_0.055_252)] shadow-md transition-colors hover:bg-[oklch(89%_0.025_79)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 md:hidden"
    >
      {isMobileMenuOpen ? (
        <PanelLeftClose aria-hidden="true" className="h-5 w-5" />
      ) : (
        <PanelLeftOpen aria-hidden="true" className="h-5 w-5" />
      )}
    </button>
  );
}
