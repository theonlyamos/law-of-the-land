"use client";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { api } from "@/convex/_generated/api";
import { useConvexAuth, useQuery } from "convex/react";
import { Loader2, LogOut, Settings, UserRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export function UserNav() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const router = useRouter();
  const user = useQuery(api.users.current, isAuthenticated ? {} : "skip");

  if (isLoading) {
    return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  }

  if (!isAuthenticated) {
    return (
      <Button asChild size="sm" variant="outline">
        <Link href="/signin">Sign in</Link>
      </Button>
    );
  }

  const displayName = user?.name ?? user?.email ?? "Account";

  return (
    <div className="flex items-center gap-2">
      <div className="hidden items-center gap-2 text-sm text-muted-foreground sm:flex">
        <UserRound className="h-4 w-4" />
        <span className="max-w-[160px] truncate">{displayName}</span>
      </div>
      <Button asChild size="sm" variant="ghost">
        <Link href="/settings/security">
          <Settings className="h-4 w-4" />
          <span className="sr-only">Account security</span>
        </Link>
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="border-0 bg-transparent text-red-700 shadow-none hover:bg-transparent hover:text-red-800 dark:text-red-400 dark:hover:text-red-300"
        onClick={() => {
          void authClient
            .signOut()
            .then(() => router.push("/"))
            .catch((error) => console.error("Sign out failed:", error));
        }}
      >
        <LogOut className="mr-2 h-4 w-4" />
        Sign out
      </Button>
    </div>
  );
}
