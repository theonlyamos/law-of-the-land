"use client";

import logo from "@/app/logo-transparent.png";
import { UserNav } from "@/components/auth/user-nav";
import { LegalInformationNotice } from "@/components/landing/legal-information-notice";
import { PublicJurisdictionSelector } from "@/components/landing/public-jurisdiction-selector";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ChatSession } from "@/lib/chat-sessions";
import type { PublicJurisdiction } from "@/lib/countries";
import { ArrowRight } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

interface LandingPageProps {
  query: string;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  onPickSuggested: (question: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  isLoading: boolean;
  savedChats: ChatSession[];
  onResumeChat: (chatId: string) => void;
  isAuthenticated: boolean;
  country: string;
  onCountryChange: (code: string) => void;
  jurisdictions: readonly PublicJurisdiction[] | undefined;
}

const PRIMARY_LINKS = [
  { href: "#jurisdictions", label: "Jurisdictions" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#for-professionals", label: "For professionals" },
  { href: "#plans", label: "Plans" },
] as const;

export function LandingPage({
  query,
  onQueryChange,
  onSearch,
  onKeyDown,
  isLoading,
  savedChats,
  onResumeChat,
  isAuthenticated,
  country,
  onCountryChange,
  jurisdictions,
}: LandingPageProps) {
  const recentChats = savedChats.slice(0, 3);
  const catalogUnavailable = jurisdictions !== undefined && jurisdictions.length === 0;
  const researchDisabled =
    isLoading || jurisdictions === undefined || catalogUnavailable || !country || !query.trim();

  return (
    <main className="flex min-h-full w-full flex-1 flex-col bg-background text-foreground">
      <header className="border-b bg-background">
        <div className="mx-auto flex min-h-[72px] w-full max-w-7xl items-center justify-between gap-5 px-4 sm:px-6 lg:px-8">
          <Link
            href="/"
            aria-label="Law of the Land home"
            className="inline-flex min-h-11 shrink-0 items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Image src={logo} alt="" width={80} height={43} priority />
          </Link>
          <nav aria-label="Primary navigation" className="hidden items-center gap-1 lg:flex">
            {PRIMARY_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="inline-flex min-h-11 items-center px-3 text-sm font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {link.label}
              </Link>
            ))}
          </nav>
          <div className="shrink-0 [&_a]:min-h-11 [&_button]:min-h-11">
            <UserNav />
          </div>
        </div>
      </header>

      <section
        className="relative overflow-hidden px-4 py-16 sm:px-6 sm:py-20 lg:px-8 lg:py-24"
        aria-labelledby="landing-title"
      >
        <span
          aria-hidden
          className="pointer-events-none absolute -right-16 -top-24 hidden select-none font-serif text-[24rem] leading-none text-foreground/[0.035] lg:block"
        >
          §
        </span>
        <div className="relative mx-auto grid w-full max-w-7xl items-center gap-12 lg:grid-cols-[minmax(0,0.9fr)_minmax(360px,0.7fr)] lg:gap-20">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand">
              Jurisdiction-specific legal research
            </p>
            <h1
              id="landing-title"
              className="mt-4 max-w-[9ch] text-balance font-serif text-5xl font-medium leading-[0.96] tracking-[-0.045em] sm:text-6xl lg:text-7xl"
            >
              Understand the law where you are.
            </h1>
            <p className="mt-6 max-w-[56ch] text-base leading-relaxed text-muted-foreground sm:text-lg">
              Ask a question in plain language. Receive a clear, jurisdiction-specific answer with
              the legal sources and citations needed to verify it.
            </p>
            <ul
              aria-label="Designed for"
              className="mt-7 flex flex-wrap gap-x-6 gap-y-3 text-xs font-semibold uppercase tracking-[0.08em]"
            >
              <li className="border-b pb-2">Individuals</li>
              <li className="border-b pb-2">Legal professionals</li>
              <li className="border-b pb-2">Organisations</li>
            </ul>
          </div>

          <form
            id="research"
            aria-label="Legal research"
            className="border bg-card shadow-elegant-lg"
            onSubmit={(event) => {
              event.preventDefault();
              if (!researchDisabled) onSearch();
            }}
          >
            <div className="border-b p-5 sm:p-6">
              <PublicJurisdictionSelector
                id="landing-jurisdiction"
                label="Research jurisdiction"
                jurisdictions={jurisdictions}
                value={country}
                onChange={onCountryChange}
              />
              {catalogUnavailable ? (
                <p role="status" className="mt-3 text-sm leading-relaxed text-muted-foreground">
                  Legal research is not available for a jurisdiction right now. Please check again
                  later.
                </p>
              ) : null}
            </div>

            <div className="p-5 sm:p-6">
              <label htmlFor="landing-question" className="block text-sm font-semibold">
                Your legal question
              </label>
              <Textarea
                id="landing-question"
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                onKeyDown={onKeyDown}
                disabled={isLoading}
                rows={4}
                placeholder="For example: What notice must a landlord give before ending a tenancy?"
                aria-describedby="landing-question-help"
                className="mt-3 min-h-28 resize-none rounded-none"
              />
              <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <p
                  id="landing-question-help"
                  className="max-w-[30ch] text-xs leading-relaxed text-muted-foreground"
                >
                  Available jurisdictions use reviewed, published legal libraries.
                </p>
                <Button
                  type="submit"
                  disabled={researchDisabled}
                  className="min-h-11 rounded-none px-5"
                >
                  Research this question
                  <ArrowRight aria-hidden className="ml-2 size-4" />
                </Button>
              </div>
            </div>

            {!isAuthenticated ? (
              <p className="border-t px-5 py-3 text-xs leading-relaxed text-muted-foreground sm:px-6">
                <Link
                  href="/signin"
                  className="inline-flex min-h-11 items-center font-semibold text-foreground underline underline-offset-4"
                >
                  Sign in
                </Link>{" "}
                to save this research thread and continue on another device.
              </p>
            ) : null}
          </form>
        </div>
      </section>

      <LegalInformationNotice className="grid gap-4 border-y bg-primary px-4 py-6 text-primary-foreground sm:grid-cols-[auto_minmax(0,0.7fr)_minmax(0,1.3fr)] sm:px-6 lg:px-8" />

      {isAuthenticated && recentChats.length > 0 ? (
        <section
          aria-labelledby="recent-research-title"
          className="border-b px-4 py-6 sm:px-6 lg:px-8"
        >
          <div className="mx-auto w-full max-w-7xl">
            <h2
              id="recent-research-title"
              className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground"
            >
              Recent research
            </h2>
            <ul className="mt-3 divide-y border-y">
              {recentChats.map((session) => (
                <li key={session.id}>
                  <button
                    type="button"
                    onClick={() => onResumeChat(session.id)}
                    className="flex min-h-11 w-full items-center justify-between gap-4 py-2 text-left text-sm font-medium transition-colors hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    <span className="truncate">{session.title}</span>
                    <ArrowRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}
    </main>
  );
}
