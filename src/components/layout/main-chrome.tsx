"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserNav } from "@/components/auth/user-nav";
import logo from "@/app/logo-transparent.png";

export function MainChrome({ children }: Readonly<{ children: React.ReactNode }>) {
  const isLanding = usePathname() === "/";

  if (isLanding) {
    return <>{children}</>;
  }

  return (
    <>
      <nav className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <Link href="/" className="flex items-center gap-2">
            <Image src={logo} alt="Law of the Land — home" width={80} priority />
          </Link>
          <div className="flex items-center gap-4">
            <UserNav />
          </div>
        </div>
      </nav>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      <div className="border-t px-4 py-3 text-center text-xs text-muted-foreground">
        General information from public legal sources, not legal advice for your case. For decisions
        that affect your rights or obligations, talk to a qualified attorney.
      </div>
    </>
  );
}
