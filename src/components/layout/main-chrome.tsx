"use client";

import { LogoMark } from "@/components/brand/logo-mark";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserNav } from "@/components/auth/user-nav";
import { EditorialTheme } from "@/components/chat/editorial-theme";

export function MainChrome({ children }: Readonly<{ children: React.ReactNode }>) {
  const pathname = usePathname();
  const isLanding = pathname === "/";

  if (isLanding) {
    return <>{children}</>;
  }

  if (pathname === "/research") {
    return (
      <EditorialTheme className="flex min-h-dvh min-w-0 flex-col">
        <nav aria-label="Main navigation" className="border-b border-border/70">
          <div className="mx-auto flex min-h-16 w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-3 sm:px-8">
            <Link href="/" aria-label="Law of the Land — home" className="flex shrink-0 items-center gap-2.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <LogoMark className="h-9 w-9" />
              <span className="font-[family-name:var(--font-chat-serif)] text-xl">Law of the Land</span>
            </Link>
            <UserNav />
          </div>
        </nav>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        <footer className="border-t border-border/70 px-5 py-4 text-center text-xs leading-relaxed text-muted-foreground">
          General legal information, not legal advice. For decisions that affect your rights, talk to a qualified attorney.
        </footer>
      </EditorialTheme>
    );
  }

  return (
    <>
      <nav className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <Link href="/" aria-label="Law of the Land — home" className="flex items-center gap-2">
            <LogoMark className="h-9 w-9" />
            <span className="text-base font-semibold tracking-tight">Law of the Land</span>
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
