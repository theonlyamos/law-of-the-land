"use client";

import {
  createContext,
  useContext,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { Menu, X } from "lucide-react";

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
      className="hidden min-h-11 items-center justify-center border border-[oklch(61%_0.035_252)] bg-[oklch(97%_0.012_82)] px-3 text-sm font-semibold text-[oklch(31%_0.055_252)] transition-colors hover:bg-[oklch(89%_0.025_79)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 md:inline-flex"
    >
      <span aria-hidden className="text-lg leading-none">
        {isCollapsed ? "›" : "‹"}
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
      className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-[oklch(61%_0.035_252)] bg-[oklch(97%_0.012_82)] text-[oklch(31%_0.055_252)] transition-colors hover:bg-[oklch(89%_0.025_79)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 md:hidden"
    >
      {isMobileMenuOpen ? (
        <X aria-hidden="true" className="h-5 w-5" />
      ) : (
        <Menu aria-hidden="true" className="h-5 w-5" />
      )}
    </button>
  );
}
