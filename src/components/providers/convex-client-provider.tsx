"use client";

import { ConvexAuthNextjsProvider } from "@convex-dev/auth/nextjs";
import { ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;

const convex = new ConvexReactClient(convexUrl ?? "https://placeholder.convex.cloud");

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  if (!convexUrl) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-md rounded-lg border bg-card p-6 text-center shadow-sm">
          <h1 className="text-lg font-semibold">Convex is not configured</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Set <code className="text-xs">NEXT_PUBLIC_CONVEX_URL</code> in your environment to enable
            authentication and saved chats.
          </p>
        </div>
      </div>
    );
  }

  return <ConvexAuthNextjsProvider client={convex}>{children}</ConvexAuthNextjsProvider>;
}
