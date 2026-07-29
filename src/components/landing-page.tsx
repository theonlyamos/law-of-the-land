"use client";

import logo from "@/app/logo-transparent.png";
import { UserNav } from "@/components/auth/user-nav";
import { LandingSections } from "@/components/landing/landing-sections";
import styles from "@/components/landing/landing-page.module.css";
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
  const plansHref = isAuthenticated
    ? "/settings/billing"
    : "/signin?redirect=%2Fsettings%2Fbilling";

  return (
    <main className={styles.page}>
      <header className={styles.mainHeader}>
        <div className={styles.headerInner}>
          <Link href="/" aria-label="Law of the Land home" className={styles.brand}>
            <Image src={logo} alt="" width={80} height={43} priority />
          </Link>
          <nav aria-label="Primary navigation" className={styles.primaryNav}>
            <ul>
              {PRIMARY_LINKS.map((link) => (
                <li key={link.href}>
                  <Link href={link.href}>{link.label}</Link>
                </li>
              ))}
              <li>
                <Link href="#research" className={styles.researchNavLink}>
                  Research
                </Link>
              </li>
            </ul>
          </nav>
          <div className={styles.accountControls}>
            <UserNav />
          </div>
        </div>
      </header>

      <section className={styles.hero} aria-labelledby="landing-title">
        <div className={styles.heroGrid}>
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>Jurisdiction-specific legal research</p>
            <h1 id="landing-title" className={styles.display}>
              Understand the law where you are.
            </h1>
            <p className={styles.heroDescription}>
              Ask a question in plain language. Receive a clear, jurisdiction-specific answer with
              the legal sources and citations needed to verify it.
            </p>
            <ul aria-label="Designed for" className={styles.audienceLine}>
              <li>Individuals</li>
              <li>Legal professionals</li>
              <li>Organisations</li>
            </ul>
          </div>

          <form
            id="research"
            tabIndex={-1}
            aria-label="Legal research"
            className={styles.researchSheet}
            onSubmit={(event) => {
              event.preventDefault();
              if (!researchDisabled) onSearch();
            }}
          >
            <div className={styles.jurisdictionField}>
              <PublicJurisdictionSelector
                id="landing-jurisdiction"
                label="Research jurisdiction"
                jurisdictions={jurisdictions}
                value={country}
                onChange={onCountryChange}
                className={styles.selectorRoot}
              />
              {catalogUnavailable ? (
                <p role="status" className={styles.unavailableMessage}>
                  Legal research is not available for a jurisdiction right now. Please check again
                  later.
                </p>
              ) : null}
            </div>

            <div className={styles.questionBody}>
              <label htmlFor="landing-question" className={styles.questionLabel}>
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
                className={styles.questionField}
              />
              <div className={styles.formFooter}>
                <p id="landing-question-help" className={styles.formHint}>
                  Available jurisdictions use reviewed, published legal libraries.
                </p>
                <Button
                  type="submit"
                  disabled={researchDisabled}
                  className={styles.researchButton}
                >
                  Research this question
                  <ArrowRight aria-hidden />
                </Button>
              </div>
            </div>

            {!isAuthenticated ? (
              <p className={styles.signInNote}>
                <Link href="/signin">Sign in</Link> to save this research thread and continue on
                another device.
              </p>
            ) : null}
          </form>
        </div>
      </section>

      <LandingSections
        jurisdictions={jurisdictions}
        recentChats={recentChats}
        isAuthenticated={isAuthenticated}
        onResumeChat={onResumeChat}
        plansHref={plansHref}
      />
    </main>
  );
}
