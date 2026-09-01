import logo from "@/app/logo-transparent.png";
import type { ChatSession } from "@/lib/chat-sessions";
import type { PublicJurisdiction } from "@/lib/countries";
import { ArrowRight } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { LegalInformationNotice } from "./legal-information-notice";
import styles from "./landing-page.module.css";

interface LandingSectionsProps {
  jurisdictions: readonly PublicJurisdiction[] | undefined;
  recentChats: readonly ChatSession[];
  isAuthenticated: boolean;
  onResumeChat: (chatId: string) => void;
  plansHref: string;
  searchFirstCoverage: boolean;
}

interface LedgerEntry {
  title: string;
  description: string;
}

interface AudienceEntry extends LedgerEntry {
  register: string;
  needs: readonly string[];
}

const ASSURANCES: readonly LedgerEntry[] = [
  {
    title: "Published legal libraries",
    description:
      "Public answers use the production sources approved for the selected jurisdiction.",
  },
  {
    title: "Citations to relevant text",
    description: "Material claims point back to the applicable sections and articles.",
  },
  {
    title: "Saved research history",
    description: "Return to prior questions and continue a research thread across devices.",
  },
];

const PROCESS: readonly LedgerEntry[] = [
  {
    title: "Select the jurisdiction",
    description:
      "Each question is tied to the reviewed legal library for the jurisdiction whose law applies.",
  },
  {
    title: "Ask in plain language",
    description:
      "Describe the legal issue as you understand it. Specialist terminology is not required.",
  },
  {
    title: "Review the explanation",
    description:
      "Read the answer, relevant qualifications, and the source references that support it.",
  },
  {
    title: "Continue the research",
    description:
      "Ask follow-up questions within the same jurisdiction and retain the full thread in your account.",
  },
];

const AUDIENCES: readonly AudienceEntry[] = [
  {
    register: "01 / Public",
    title: "Individuals",
    description:
      "Understand laws that affect everyday life without beginning with a specialist database.",
    needs: ["Housing and tenancy", "Employment and workplace rights", "Consumer and public services"],
  },
  {
    register: "02 / Practice",
    title: "Legal professionals",
    description:
      "Accelerate issue spotting and source discovery while preserving a clear path back to the legal text.",
    needs: ["Preliminary legal research", "Section and article discovery", "Jurisdiction-specific review"],
  },
  {
    register: "03 / Operations",
    title: "Organisations",
    description:
      "Develop an initial understanding of legislation and regulations relevant to operations and compliance.",
    needs: ["Business obligations", "Regulatory requirements", "Policy and compliance research"],
  },
];

const CONTINUITY: readonly string[] = [
  "Jurisdiction remains fixed for the research thread",
  "Conversation history is saved to your account",
  "Active sessions can be reviewed and revoked",
];

function registerNumber(index: number) {
  return String(index + 1).padStart(2, "0");
}

export function LandingSections({
  jurisdictions,
  recentChats,
  isAuthenticated,
  onResumeChat,
  plansHref,
  searchFirstCoverage,
}: LandingSectionsProps) {
  return (
    <>
      <section aria-label="Research assurances" className={styles.assuranceLedger}>
        <ol>
          {ASSURANCES.map((assurance, index) => (
            <li key={assurance.title}>
              <span className={styles.index}>{registerNumber(index)}</span>
              <div>
                <strong>{assurance.title}</strong>
                <p>{assurance.description}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <LegalInformationNotice className={styles.legalNotice} />

      <section
        id="how-it-works"
        aria-labelledby="how-it-works-title"
        className={`${styles.section} ${styles.howSection}`}
      >
        <div className={styles.sectionLead}>
          <p className={styles.eyebrow}>How answers work</p>
          <h2 id="how-it-works-title" className={styles.sectionTitle}>
            Clear explanations. Verifiable sources.
          </h2>
          <p className={styles.sectionCopy}>
            The research flow separates the explanation from the source trail, so you can start
            with the answer and examine the underlying legal text when greater detail is required.
          </p>
          <figure className={styles.sourceDocket}>
            <figcaption>Illustrative answer structure</figcaption>
            <div>Plain-language explanation</div>
            <div>Relevant conditions and exceptions</div>
            <div aria-label="Illustrative source trail">
              Act or regulation <span aria-hidden>{"\u00b7"}</span> Section or article
            </div>
          </figure>
        </div>

        <ol className={styles.processLedger}>
          {PROCESS.map((step, index) => (
            <li key={step.title}>
              <span className={styles.index}>{registerNumber(index)}</span>
              <div>
                <strong>{step.title}</strong>
                <p>{step.description}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section
        id="for-professionals"
        aria-labelledby="audience-title"
        className={`${styles.section} ${styles.audienceSection}`}
      >
        <div className={styles.audienceHeader}>
          <div>
            <p className={styles.eyebrow}>Designed for informed decisions</p>
            <h2 id="audience-title" className={styles.sectionTitle}>
              Built for everyday questions and professional research.
            </h2>
          </div>
          <p className={styles.sectionCopy}>
            The same research system supports a straightforward personal question, a professional
            source check, or an initial review of regulatory obligations.
          </p>
        </div>

        <ol className={styles.audienceRegister}>
          {AUDIENCES.map((audience) => (
            <li key={audience.title}>
              <article>
                <span className={styles.index}>{audience.register}</span>
                <h3>{audience.title}</h3>
                <p>{audience.description}</p>
                <ul>
                  {audience.needs.map((need) => (
                    <li key={need}>{need}</li>
                  ))}
                </ul>
              </article>
            </li>
          ))}
        </ol>
      </section>

      <section
        id="jurisdictions"
        aria-label="Published jurisdiction coverage"
        className={`${styles.section} ${styles.coverageSection}`}
      >
        <div className={styles.coverageGrid}>
          <div>
            <p className={styles.eyebrow}>Governed jurisdiction coverage</p>
            <h2 className={styles.sectionTitle}>Coverage grows through governed publication.</h2>
            <p className={styles.sectionCopy}>
              A jurisdiction becomes available only after its legal sources are reviewed and
              published to the production library. This keeps public coverage explicit and
              verifiable.
            </p>
          </div>

          <div className={styles.coverageRegister}>
            <h3>{searchFirstCoverage ? "Search governed coverage" : "Published jurisdiction register"}</h3>
            {searchFirstCoverage ? (
              <p className={styles.registerState}>
                Search by place or organization to find enabled public coverage and organizations
                available through your membership.
              </p>
            ) : jurisdictions === undefined ? (
              <p className={styles.registerState}>
                {"Loading the published jurisdiction register\u2026"}
              </p>
            ) : jurisdictions.length === 0 ? (
              <p className={styles.registerState}>
                Legal research is not available for a jurisdiction right now. Please check again
                later.
              </p>
            ) : (
              <ul>
                {jurisdictions.map((jurisdiction) => (
                  <li key={jurisdiction.code}>
                    <span className={styles.jurisdictionCode}>{jurisdiction.code}</span>
                    <span>
                      <strong>{jurisdiction.name}</strong>
                      <small>Production legal library</small>
                    </span>
                    <span className={styles.status}>Available</span>
                  </li>
                ))}
              </ul>
            )}
            <p className={styles.coverageNote}>
              {searchFirstCoverage
                ? "Search results are bounded and reflect the access available to the current account."
                : "The public selector updates automatically as additional jurisdictions complete review and publication."}
            </p>
          </div>
        </div>
      </section>

      <section
        id="continuity"
        aria-labelledby="continuity-title"
        className={`${styles.section} ${styles.continuitySection}`}
      >
        <div className={styles.continuityGrid}>
          <div>
            <p className={styles.eyebrow}>Research continuity</p>
            <h2 id="continuity-title" className={styles.sectionTitle}>
              Research that remains available when you return.
            </h2>
            <p className={styles.sectionCopy}>
              Each saved thread retains its jurisdiction and conversation history, allowing you to
              revisit an answer or continue with a follow-up question without rebuilding the
              context.
            </p>
            <ol className={styles.continuityLedger}>
              {CONTINUITY.map((item, index) => (
                <li key={item}>
                  <span className={styles.index}>{registerNumber(index)}</span>
                  <strong>{item}</strong>
                </li>
              ))}
            </ol>
          </div>

          <div className={styles.workspacePreview}>
            <div className={styles.workspaceHeader}>
              <span>Research workspace</span>
              {isAuthenticated ? (
                <Link href="/settings/sessions">Session controls</Link>
              ) : (
                <span>Account continuity</span>
              )}
            </div>
            {isAuthenticated ? (
              <section className={styles.savedResearch} aria-labelledby="recent-research-title">
                <h3 id="recent-research-title">Recent research</h3>
                {recentChats.length > 0 ? (
                  <ul>
                    {recentChats.map((session) => (
                      <li key={session.id}>
                        <button type="button" onClick={() => onResumeChat(session.id)}>
                          <span>{session.title}</span>
                          <ArrowRight aria-hidden />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>Your saved research threads will appear here after you begin.</p>
                )}
              </section>
            ) : (
              <div className={styles.guestContinuity}>
                <p className={styles.eyebrow}>Continue across devices</p>
                <h3>Keep the question, sources, and follow-up research together.</h3>
                <p>
                  Sign in to save research threads, revisit prior answers, and continue your work
                  on another device.
                </p>
                <Link href="/signin">Sign in</Link>
              </div>
            )}
          </div>
        </div>
      </section>

      <section id="plans" aria-labelledby="plans-title" className={styles.plansSection}>
        <div>
          <h2 id="plans-title">
            Start with free research. Increase the daily allowance when your work requires it.
          </h2>
          <p>
            Every account includes saved research threads and citations. Plan availability and
            allowances are shown clearly before an upgrade.
          </p>
        </div>
        <Link href={plansHref} className={styles.secondaryAction}>
          Review plans <ArrowRight aria-hidden />
        </Link>
      </section>

      <section aria-labelledby="closing-title" className={styles.closingSection}>
        <h2 id="closing-title">Begin with the jurisdiction whose law applies.</h2>
        <Link href="#research" className={styles.primaryAction}>
          Choose a jurisdiction <ArrowRight aria-hidden />
        </Link>
      </section>

      <footer className={styles.footer}>
        <Link href="/" className={styles.footerBrand} aria-label="Law of the Land home">
          <Image src={logo} alt="" width={80} height={43} className={styles.footerLogo} />
          <strong>Law of the Land</strong>
        </Link>
        <nav aria-label="Footer navigation">
          <Link href="#jurisdictions">Coverage</Link>
          <Link href="#legal-information-notice">Legal notice</Link>
        </nav>
      </footer>
    </>
  );
}
