"use client";

import {
  createContext,
  useContext,
  type ReactNode,
} from "react";

const AdminPermissionContext = createContext<ReadonlySet<string>>(
  new Set(),
);

export function AdminPermissionProvider({
  permissions,
  children,
}: {
  permissions: readonly string[];
  children: ReactNode;
}) {
  return (
    <AdminPermissionContext.Provider value={new Set(permissions)}>
      {children}
    </AdminPermissionContext.Provider>
  );
}

type PermissionBoundaryProps = {
  resource: string;
  action: string;
  fallback?: ReactNode;
  children: ReactNode;
};

/**
 * Hides unusable controls. Convex permission checks remain authoritative.
 */
export function PermissionBoundary({
  resource,
  action,
  fallback = null,
  children,
}: PermissionBoundaryProps) {
  const permissions = useContext(AdminPermissionContext);
  return permissions.has(`${resource}:${action}`) ? children : fallback;
}
