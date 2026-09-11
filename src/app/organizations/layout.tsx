"use client";

import { AccountProviders } from "@/components/providers/account-providers";
import { Authenticated, AuthLoading, Unauthenticated } from "convex/react";
import Link from "next/link";

export default function OrganizationsLayout({ children }: { children: React.ReactNode }) {
  return <AccountProviders>
    <AuthLoading><p role="status" className="p-8">Loading your organization…</p></AuthLoading>
    <Authenticated>{children}</Authenticated>
    <Unauthenticated><p className="p-8"><Link href="/signin" className="underline">Sign in</Link> to access your organizations.</p></Unauthenticated>
  </AccountProviders>;
}
