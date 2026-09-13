"use client";

import { useConvexAuth } from "convex/react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";

export function AdminAuthBoundary({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const pathname = usePathname();
  const search = useSearchParams().toString();

  if (isLoading) {
    return <p role="status" className="py-10 text-sm">Verifying your session…</p>;
  }
  if (!isAuthenticated) {
    return (
      <div role="alert" className="space-y-3 py-10 text-sm">
        <p>Your session could not be verified. Sign in again to continue.</p>
        <Link
          href={`/signin?redirect=${encodeURIComponent(`${pathname ?? "/admin"}${search ? `?${search}` : ""}`)}`}
          className="inline-flex min-h-11 items-center font-semibold underline decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
        >
          Sign in again
        </Link>
      </div>
    );
  }

  return children;
}
