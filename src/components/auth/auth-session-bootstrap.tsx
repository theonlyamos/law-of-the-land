"use client";

import { useEffect } from "react";
import { useConvexAuth, useMutation } from "convex/react";
import { migrateLocalSessionsToConvex } from "@/lib/migrate-local-sessions";
import { api } from "@/convex/_generated/api";

export function AuthSessionBootstrap() {
  const { isAuthenticated } = useConvexAuth();
  const migrateFromLocal = useMutation(api.chats.migrateFromLocal);

  useEffect(() => {
    if (!isAuthenticated) return;
    void migrateLocalSessionsToConvex(migrateFromLocal);
  }, [isAuthenticated, migrateFromLocal]);

  return null;
}
