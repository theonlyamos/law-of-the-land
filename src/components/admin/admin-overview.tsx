import type { AdminOverview as AdminOverviewData } from "@/lib/admin/server";
import Link from "next/link";
import { PermissionBoundary } from "./permission-boundary";

const riskActionLabels: Record<string, string> = {
  "admin.roles_changed": "Administrative roles changed",
  "admin.bootstrap_super_admin": "Super administrator bootstrapped",
  "user.banned": "User access suspended",
  "user.deletion_queued": "User deletion queued",
  "conversation.exported": "Conversation exported",
  "document.published": "Document published",
  "document.unpublished": "Document unpublished",
  "document.rollback": "Document publication rolled back",
  "billing.changed": "Billing state changed",
  "operations.job_retried": "Provider job retried",
};

function formatEventTime(timestamp: number) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(timestamp));
}

export function AdminOverview({ overview }: { overview: AdminOverviewData }) {
  return (
    <div className="mx-auto max-w-[86rem]">
      <header className="max-w-4xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[oklch(43%_0.065_67)]">
          Control room · current posture
        </p>
        <h1 className="mt-3 text-balance text-[clamp(2.25rem,6vw,5.25rem)] font-semibold leading-[0.96] tracking-[-0.055em] text-[oklch(23%_0.05_252)]">
          System overview
        </h1>
        <p className="mt-5 max-w-[62ch] text-base leading-7 text-[oklch(42%_0.035_252)] sm:text-lg">
          A bounded view of site-wide administration. Delayed aggregates are
          identified explicitly; operational queues never scan source records.
        </p>
      </header>

      <div className="mt-12 grid gap-12 xl:grid-cols-[minmax(0,1.55fr)_minmax(19rem,0.7fr)] xl:gap-16">
        <section aria-labelledby="overview-aggregate-heading">
          <div className="flex items-end justify-between gap-6 border-b-2 border-[oklch(37%_0.055_252)] pb-3">
            <h2 id="overview-aggregate-heading" className="text-lg font-semibold tracking-tight">
              Operating ledger
            </h2>
            <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[oklch(48%_0.035_252)]">
              Fixed aggregates
            </span>
          </div>
          <dl className="divide-y divide-[oklch(79%_0.025_78)]">
            {overview.counters.map((counter, index) => (
              <div
                key={counter.key}
                className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-baseline gap-3 py-5 sm:grid-cols-[3rem_minmax(0,1fr)_minmax(8rem,auto)]"
              >
                <dt className="contents">
                  <span aria-hidden className="text-xs font-semibold tabular-nums text-[oklch(52%_0.035_252)]">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="text-sm font-semibold text-[oklch(30%_0.045_252)] sm:text-base">
                    {counter.label}
                  </span>
                </dt>
                <dd className="text-right">
                  {counter.value === null ? (
                    <span>
                      <span className="block text-xl font-semibold" aria-label="Not available">—</span>
                      <span className="block text-xs font-medium text-[oklch(48%_0.04_252)]">
                        Aggregate pending
                      </span>
                    </span>
                  ) : (
                    <span className="text-2xl font-semibold tabular-nums tracking-tight">
                      {counter.value.toLocaleString("en")}
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <aside className="border-t-4 border-[oklch(55%_0.1_68)] bg-[oklch(89%_0.04_78)] px-5 py-6 sm:px-7" aria-labelledby="overview-briefing-heading">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[oklch(40%_0.07_65)]">
            Briefing note
          </p>
          <h2 id="overview-briefing-heading" className="mt-3 text-2xl font-semibold tracking-[-0.035em]">
            Read model warming up
          </h2>
          <p className="mt-4 text-sm leading-6 text-[oklch(38%_0.04_252)]">
            Aggregate counters become available as the legal catalog, provider
            jobs, and telemetry slices are enabled. An em dash means the value
            has not been measured yet—not zero.
          </p>
          <PermissionBoundary resource="operations" action="read">
            <Link
              href="/admin/operations"
              className="mt-6 inline-flex min-h-11 items-center text-sm font-semibold text-[oklch(31%_0.065_252)] underline decoration-[oklch(56%_0.11_68)] decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
            >
              Open operations
            </Link>
          </PermissionBoundary>
        </aside>
      </div>

      <div className="mt-16 grid gap-14 lg:grid-cols-2 lg:gap-x-16 xl:grid-cols-[0.9fr_0.9fr_1.2fr]">
        <PermissionBoundary resource="operations" action="read">
          <section aria-labelledby="failed-jobs-heading">
            <div className="border-b border-[oklch(68%_0.035_78)] pb-3">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[oklch(48%_0.04_252)]">Attention</p>
              <h2 id="failed-jobs-heading" className="mt-1 text-xl font-semibold tracking-tight">Failed jobs</h2>
            </div>
            {overview.failedJobs.length === 0 ? (
              <p className="mt-5 text-sm leading-6 text-[oklch(43%_0.035_252)]">
                No failed jobs require attention.
              </p>
            ) : (
              <ol className="divide-y divide-[oklch(79%_0.025_78)]">
                {overview.failedJobs.map((job) => (
                  <li key={job.id} className="py-4">
                    <p className="font-semibold">{job.label}</p>
                    <p className="mt-1 text-xs text-[oklch(46%_0.04_252)]">{job.status.replace("_", " ")} · {formatEventTime(job.updatedAt)}</p>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </PermissionBoundary>

        <PermissionBoundary resource="document" action="review">
          <section aria-labelledby="review-queue-heading">
            <div className="border-b border-[oklch(68%_0.035_78)] pb-3">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[oklch(48%_0.04_252)]">Legal library</p>
              <h2 id="review-queue-heading" className="mt-1 text-xl font-semibold tracking-tight">Review queue</h2>
            </div>
            {overview.reviewItems.length === 0 ? (
              <p className="mt-5 text-sm leading-6 text-[oklch(43%_0.035_252)]">
                Review queue is clear.
              </p>
            ) : (
              <ol className="divide-y divide-[oklch(79%_0.025_78)]">
                {overview.reviewItems.map((item) => (
                  <li key={item.id} className="py-4">
                    <p className="font-semibold">{item.title}</p>
                    <p className="mt-1 text-xs text-[oklch(46%_0.04_252)]">Submitted {formatEventTime(item.submittedAt)}</p>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </PermissionBoundary>

        <PermissionBoundary resource="audit" action="read_masked">
          <section aria-labelledby="high-risk-heading" className="lg:col-span-2 xl:col-span-1">
            <div className="border-b border-[oklch(68%_0.035_78)] pb-3">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[oklch(48%_0.04_252)]">Governance</p>
              <h2 id="high-risk-heading" className="mt-1 text-xl font-semibold tracking-tight">Recent high-risk actions</h2>
            </div>
            {overview.highRiskEvents.length === 0 ? (
              <p className="mt-5 text-sm leading-6 text-[oklch(43%_0.035_252)]">
                No high-risk actions recorded.
              </p>
            ) : (
              <ol className="divide-y divide-[oklch(79%_0.025_78)]">
                {overview.highRiskEvents.map((event, index) => (
                  <li key={`${event.action}-${event.createdAt}-${index}`} className="grid grid-cols-[0.55rem_minmax(0,1fr)] gap-3 py-4">
                    <span aria-hidden className={`mt-1.5 h-2 w-2 rounded-full ${event.outcome === "success" ? "bg-[oklch(48%_0.08_145)]" : "bg-[oklch(52%_0.15_28)]"}`} />
                    <div>
                      <p className="text-sm font-semibold">{riskActionLabels[event.action] ?? event.action}</p>
                      <p className="mt-1 text-xs text-[oklch(46%_0.04_252)]">{event.outcome} · {formatEventTime(event.createdAt)}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </PermissionBoundary>
      </div>
    </div>
  );
}
