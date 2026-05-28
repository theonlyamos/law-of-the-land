"use client";

import { useEffect } from "react";
import { useConvexAuth, useMutation } from "convex/react";
import { migrateLocalSessionsToConvex } from "@/lib/migrate-local-sessions";
import { api } from "@/convex/_generated/api";

export function AuthSessionBootstrap() {
  const { isAuthenticated } = useConvexAuth();
  const touchSession = useMutation(api.sessions.touchSession);
  const migrateFromLocal = useMutation(api.chats.migrateFromLocal);

  useEffect(() => {
    if (!isAuthenticated) return;

    void touchSession({
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
    });

    void migrateLocalSessionsToConvex(migrateFromLocal);
  }, [isAuthenticated, touchSession, migrateFromLocal]);

  return null;
}
