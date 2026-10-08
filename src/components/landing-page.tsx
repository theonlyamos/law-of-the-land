"use client";

import logo from "@/app/logo-transparent.png";
import { UserNav } from "@/components/auth/user-nav";
import { EditorialTheme } from "@/components/chat/editorial-theme";
import { LandingSections } from "@/components/landing/landing-sections";
import styles from "@/components/landing/landing-page.module.css";
import { ResearchJurisdictionPicker } from "@/components/jurisdictions/research-jurisdiction-picker";
import { ChatInput } from "@/components/ui/chat-input";
import type { ChatSession } from "@/lib/chat-sessions";
import type { ResearchJurisdiction } from "@/lib/countries";
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
  guestResearchEnabled: boolean;
  researchJurisdiction: ResearchJurisdiction | null;
  onResearchJurisdictionChange: (selection: ResearchJurisdiction | null) => void;
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
  guestResearchEnabled,
  researchJurisdiction,
  onResearchJurisdictionChange,
}: LandingPageProps) {
  const recentChats = savedChats.slice(0, 3);
  const selectorReady = Boolean(researchJurisdiction?.id);
  const researchDisabled =
    isLoading || !selectorReady || !query.trim();
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
                <Link href="#research">
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

          <EditorialTheme className={styles.researchSheet}>
            <form
              id="research"
              tabIndex={-1}
              aria-label="Legal research"
              onSubmit={(event) => {
                event.preventDefault();
                if (!researchDisabled) onSearch();
              }}
            >
              <p className="chat-eyebrow mb-4">Clarity starts here</p>
              <h2 className="mb-5 font-[family-name:var(--font-chat-serif)] text-3xl leading-tight sm:text-4xl">
                Start with a question.
              </h2>
              <ChatInput
                id="landing-question"
                variant="editorial"
                ariaLabel="Your legal question"
                query={query}
                onQueryChange={onQueryChange}
                onSearch={() => { if (!researchDisabled) onSearch(); }}
                onKeyDown={onKeyDown}
                isLoading={isLoading}
                submitDisabled={!selectorReady}
                rows={3}
                placeholder="What would you like to understand?"
                describedBy="landing-question-help"
                footer={
                  <ResearchJurisdictionPicker
                    compact
                    disabled={isLoading}
                    value={researchJurisdiction}
                    onChange={onResearchJurisdictionChange}
                  />
                }
              />
              <p id="landing-question-help" className="mt-3 text-xs leading-5 text-muted-foreground" aria-live="polite">
                {researchJurisdiction
                  ? `Answers will use sources relevant to ${researchJurisdiction.organization ? `${researchJurisdiction.organization.name} / ` : ""}${researchJurisdiction.name}.`
                  : "Choose the jurisdiction your question relates to."}
              </p>

              {!isAuthenticated ? (
                <p className={styles.signInNote}>
                  {guestResearchEnabled ? <>Try one question and one follow-up free. No account required.{" "}
                    <Link href="/signin">Sign in</Link> to save your research.</>
                    : <><Link href="/signin?mode=signup">Create a free account</Link> to research this question and save your work.</>}
                </p>
              ) : null}
            </form>
          </EditorialTheme>
        </div>
      </section>

      <LandingSections
        recentChats={recentChats}
        isAuthenticated={isAuthenticated}
        onResumeChat={onResumeChat}
        plansHref={plansHref}
      />
    </main>
  );
}
