import Link from "next/link";
import { redirect } from "next/navigation";
import { makeFunctionReference } from "convex/server";
import { hasRolePermission } from "../../../../convex/lib/adminPermissions";
import { AnalyticsCharts } from "@/components/admin/analytics-charts";
import { authorizeAdminPage } from "@/lib/admin/server";
import { fetchAuthQuery } from "@/lib/auth-server";

type Metric = {
  id: string;
  day: string;
  jurisdictionCode?: string;
  jurisdictionId?: string;
  jurisdictionName?: string;
  jurisdictionKind?: "geographic" | "organizational";
  totalQuestions: number;
  successCount: number;
  failureCount: number;
  abortedCount: number;
  providerFailureCount: number;
  noResultCount: number;
  p50UpperBoundMs: number;
  p95UpperBoundMs: number;
  updatedAt: number;
};
const listDailyMetrics = makeFunctionReference<
  "query",
  { paginationOpts: { numItems: number; cursor: string | null }; jurisdictionId: string | null; jurisdictionCode: string | null; fromDay: string; toDay: string },
  { page: Metric[]; isDone: boolean; continueCursor: string }
>("admin/analytics:listDailyMetrics");

function utcDay(date: Date): string { return date.toISOString().slice(0, 10); }

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ cursor?: string; jurisdiction?: string; from?: string; to?: string }> }) {
  const access = await authorizeAdminPage();
  if (access.status === "denied" || !hasRolePermission(access.currentAdmin.roles, "analytics", "read")) redirect("/admin/forbidden");
  const parameters = await searchParams;
  const today = new Date();
  const defaultFrom = new Date(today.getTime() - 29 * 86_400_000);
  const fromDay = parameters.from ?? utcDay(defaultFrom);
  const toDay = parameters.to ?? utcDay(today);
  const jurisdictionFilter = parameters.jurisdiction?.trim() || null;
  const jurisdictionCode = jurisdictionFilter && /^[A-Za-z]{2}$/.test(jurisdictionFilter) ? jurisdictionFilter.toUpperCase() : null;
  const jurisdictionId = jurisdictionFilter && !jurisdictionCode ? jurisdictionFilter : null;
  let failed = false;
  let metrics: { page: Metric[]; isDone: boolean; continueCursor: string } = { page: [], isDone: true, continueCursor: "" };
  try {
    metrics = await fetchAuthQuery(listDailyMetrics, {
      paginationOpts: { numItems: 30, cursor: parameters.cursor ?? null },
      jurisdictionId,
      jurisdictionCode,
      fromDay,
      toDay,
    });
  } catch { failed = true; }
  const totals = metrics.page.reduce((summary, row) => ({
    questions: summary.questions + row.totalQuestions,
    failures: summary.failures + row.providerFailureCount,
    empty: summary.empty + row.noResultCount,
  }), { questions: 0, failures: 0, empty: 0 });
  const next = new URLSearchParams({ cursor: metrics.continueCursor, from: fromDay, to: toDay });
  if (jurisdictionFilter) next.set("jurisdiction", jurisdictionFilter);

  return <div className="mx-auto max-w-[90rem]">
    <header className="grid gap-6 border-b-2 border-[oklch(35%_0.055_252)] pb-7 lg:grid-cols-[1.25fr_0.75fr] lg:items-end">
      <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-[oklch(43%_0.065_67)]">Control / daily evidence</p><h1 className="mt-3 max-w-4xl text-[clamp(2.5rem,6vw,5rem)] font-semibold leading-[0.93] tracking-[-0.055em]">Operational analytics</h1></div>
      <p className="text-sm leading-6 text-slate-700">A delayed, privacy-bounded record of retrieval and generation health. Figures are grouped by UTC day and jurisdiction.</p>
    </header>
    <form className="mt-7 grid gap-3 border-b border-slate-400 pb-7 sm:grid-cols-2 lg:grid-cols-[9rem_11rem_11rem_auto] lg:items-end" method="get">
      <label className="grid gap-1 text-sm font-semibold">Jurisdiction ID or legacy code<input name="jurisdiction" defaultValue={jurisdictionFilter ?? ""} maxLength={64} placeholder="All" className="min-h-11 border border-slate-500 bg-white px-3" /></label>
      <label className="grid gap-1 text-sm font-semibold">From (UTC)<input type="date" name="from" defaultValue={fromDay} className="min-h-11 border border-slate-500 bg-white px-3" /></label>
      <label className="grid gap-1 text-sm font-semibold">To (UTC)<input type="date" name="to" defaultValue={toDay} className="min-h-11 border border-slate-500 bg-white px-3" /></label>
      <button className="min-h-11 border-2 border-slate-800 bg-slate-900 px-5 font-semibold text-stone-50 hover:bg-amber-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700">Apply range</button>
    </form>
    {failed ? <p role="alert" className="mt-8 border border-red-800 bg-red-50 p-4 text-red-950">Aggregate metrics could not be loaded. Try a shorter range.</p> : null}
    <p className="mt-9 text-xs font-semibold uppercase tracking-[0.16em] text-slate-600">Current cursor page totals</p>
    <dl className="mt-2 grid border-y-2 border-slate-700 sm:grid-cols-3 sm:divide-x sm:divide-slate-400">
      {[['Questions on this page', totals.questions], ['Provider failures on this page', totals.failures], ['Empty results on this page', totals.empty]].map(([label, value]) => <div key={label} className="px-4 py-5 first:pl-0"><dt className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-600">{label}</dt><dd className="mt-2 font-serif text-4xl font-semibold tabular-nums">{Number(value).toLocaleString("en-US")}</dd></div>)}
    </dl>
    <AnalyticsCharts jurisdictionId={jurisdictionId} jurisdictionCode={jurisdictionCode} fromDay={fromDay} toDay={toDay} />
    <section className="mt-14" aria-labelledby="daily-register-heading">
      <h2 id="daily-register-heading" className="font-serif text-3xl font-semibold">Daily register</h2>
      <p className="mt-2 text-sm text-slate-700">Supporting rows are cursor-paginated; each figure comes from the aggregate table.</p>
      <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[58rem] border-collapse text-left text-sm"><thead><tr className="border-y-2 border-slate-700"><th className="p-3">UTC day</th><th className="p-3">Jurisdiction</th><th className="p-3">Questions</th><th className="p-3">Provider failures</th><th className="p-3">Empty results</th><th className="p-3">p50 bound</th><th className="p-3">p95 bound</th></tr></thead><tbody>{metrics.page.map((row) => <tr key={row.id} className="border-b border-slate-300"><td className="p-3 font-semibold"><time dateTime={row.day}>{row.day}</time></td><td className="p-3">{row.jurisdictionName ?? row.jurisdictionCode ?? "Unknown"}</td><td className="p-3 tabular-nums">{row.totalQuestions}</td><td className="p-3 tabular-nums">{row.providerFailureCount}</td><td className="p-3 tabular-nums">{row.noResultCount}</td><td className="p-3 tabular-nums">≤ {row.p50UpperBoundMs} ms</td><td className="p-3 tabular-nums">≤ {row.p95UpperBoundMs} ms</td></tr>)}</tbody></table></div>
      {!metrics.isDone ? <Link href={`/admin/analytics?${next.toString()}`} className="mt-4 inline-flex min-h-11 items-center font-semibold underline decoration-2 decoration-amber-700 underline-offset-4">Next metrics page</Link> : null}
    </section>
  </div>;
}
