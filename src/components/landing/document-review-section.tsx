import { ArrowRight } from "lucide-react";
import Link from "next/link";
import styles from "./landing-page.module.css";

interface DocumentReviewSectionProps {
  isAuthenticated: boolean;
}

const REVIEW_STEPS = [
  {
    title: "Attach the document",
    description:
      "Add any legal document as a PDF, Word file, text file or photo: a contract, tenancy agreement, employment letter, notice, policy or will. Files can be up to 10 MB and 100 pages.",
  },
  {
    title: "Say what you need to know",
    description:
      "Ask in your own words, for example “Is this lease fair to me?” Two short questions then confirm which side you are on and what concerns you most.",
  },
  {
    title: "Each part is checked against the law",
    description:
      "The document is read section by section, and each part is compared with the legal library published for the jurisdiction you choose.",
  },
  {
    title: "Read the results beside your document",
    description:
      "Every finding is labelled, cites the provision it relies on, and where it helps, suggests wording you could raise or propose.",
  },
] as const;

const REVIEW_STATUSES = [
  {
    tone: "attention",
    label: "Needs attention",
    description: "Appears to conflict with the law, or carries a significant risk for your side.",
  },
  {
    tone: "check",
    label: "Worth checking",
    description: "Likely lawful, but unusual, unclear, or worth negotiating.",
  },
  {
    tone: "fine",
    label: "Looks fine",
    description: "Consistent with the published law for your jurisdiction.",
  },
  {
    tone: "unconfirmed",
    label: "No law cited",
    description: "No provision in the published library deals with it, so it is marked rather than guessed.",
  },
] as const;

const SAMPLE_FINDINGS = [
  { part: "Clause 4", title: "Termination", tone: "attention", label: "Needs attention" },
  { part: "Clause 7", title: "Security deposit", tone: "check", label: "Worth checking" },
  { part: "Clause 9", title: "Governing law", tone: "fine", label: "Looks fine" },
] as const;

const REVIEW_NOTES = [
  "Any legal document can be reviewed, not only contracts.",
  "Files stay attached to your own research thread.",
  "Document review needs a free account.",
] as const;

function stepNumber(index: number) {
  return String(index + 1).padStart(2, "0");
}

export function DocumentReviewSection({ isAuthenticated }: DocumentReviewSectionProps) {
  const reviewHref = isAuthenticated ? "/new" : "/signin?mode=signup&redirect=%2Fnew";

  return (
    <section
      id="document-review"
      aria-labelledby="document-review-title"
      className={`${styles.section} ${styles.reviewSection}`}
    >
      <div className={styles.audienceHeader}>
        <div>
          <p className={styles.eyebrow}>Document review</p>
          <h2 id="document-review-title" className={`${styles.sectionTitle} ${styles.reviewTitle}`}>
            Check a document against the law before you rely on it.
          </h2>
        </div>
        <p className={styles.sectionCopy}>
          Attach a document and ask what you need to know. Each part is compared with the
          published law for your jurisdiction, and the results appear beside the document with the
          provisions they rely on.
        </p>
      </div>

      <div className={styles.reviewGrid}>
        <ol className={styles.processLedger}>
          {REVIEW_STEPS.map((step, index) => (
            <li key={step.title}>
              <span className={styles.index}>{stepNumber(index)}</span>
              <div>
                <strong>{step.title}</strong>
                <p>{step.description}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className={styles.reviewAside}>
          <figure className={styles.reviewFigure}>
            <figcaption>Illustrative review layout</figcaption>
            <div className={styles.reviewPanes}>
              <div className={styles.reviewDocument}>
                <span className={styles.reviewPaneLabel}>Your document</span>
                {SAMPLE_FINDINGS.map((finding) => (
                  <p key={finding.part} data-tone={finding.tone}>
                    <strong>{finding.part}</strong> {finding.title}
                    <span aria-hidden className={styles.reviewLines}>
                      <span />
                      <span />
                    </span>
                  </p>
                ))}
              </div>
              <ul className={styles.reviewFindings} aria-label="Findings">
                {SAMPLE_FINDINGS.map((finding) => (
                  <li key={finding.part} data-tone={finding.tone}>
                    <span className={styles.reviewStatus}>{finding.label}</span>
                    <strong>
                      {finding.part} {"·"} {finding.title}
                    </strong>
                    <span className={styles.reviewCitation}>
                      Act or regulation {"·"} Section
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </figure>

          <dl className={styles.reviewLegend} aria-label="What each label means">
            {REVIEW_STATUSES.map((status) => (
              <div key={status.label} data-tone={status.tone}>
                <dt>{status.label}</dt>
                <dd>{status.description}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      <div className={styles.reviewFooter}>
        <ul>
          {REVIEW_NOTES.map((note) => (
            <li key={note}>{note}</li>
          ))}
          <li>
            The review is general legal information, not legal advice. For decisions with serious
            consequences, consult a qualified lawyer.
          </li>
        </ul>
        <Link href={reviewHref} className={styles.primaryAction}>
          {isAuthenticated ? "Review a document" : "Create a free account to review"}
          <ArrowRight aria-hidden />
        </Link>
      </div>
    </section>
  );
}
