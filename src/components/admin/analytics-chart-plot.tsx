"use client";

export type AnalyticsMetric = {
  day: string;
  jurisdictionCode: string;
  totalQuestions: number;
  failureCount: number;
  noResultCount: number;
  p95LatencyMs: number;
};

function points(values: readonly number[], maximum: number): string {
  if (values.length === 1) return `24,${156 - (values[0] / maximum) * 116} 576,${156 - (values[0] / maximum) * 116}`;
  return values.map((value, index) => {
    const x = 24 + (index / (values.length - 1)) * 552;
    const y = 156 - (value / maximum) * 116;
    return `${x},${y}`;
  }).join(" ");
}

function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default function AnalyticsChartPlot({ metrics }: { metrics: readonly AnalyticsMetric[] }) {
  const chronological = [...metrics].sort((left, right) => left.day.localeCompare(right.day));
  const maximum = Math.max(1, ...chronological.map((row) => row.totalQuestions));
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1.6fr)_minmax(18rem,0.8fr)] lg:items-start">
      <div className="overflow-hidden border-y-2 border-slate-700 bg-[oklch(98%_0.012_82)] py-5">
        <svg
          role="img"
          aria-label="Question volume and failures by UTC day"
          viewBox="0 0 600 190"
          className="h-auto min-h-48 w-full"
        >
          <title>Question volume and failures by UTC day</title>
          <path d="M24 40H576M24 98H576M24 156H576" stroke="oklch(82% 0.02 78)" strokeWidth="1" />
          <polyline points={points(chronological.map((row) => row.totalQuestions), maximum)} fill="none" stroke="oklch(42% 0.12 53)" strokeWidth="5" strokeLinecap="square" strokeLinejoin="miter" />
          <polyline points={points(chronological.map((row) => row.failureCount), maximum)} fill="none" stroke="oklch(36% 0.06 252)" strokeWidth="4" strokeDasharray="12 8" strokeLinecap="square" strokeLinejoin="miter" />
        </svg>
        <div className="flex flex-wrap gap-x-7 gap-y-2 px-4 text-xs font-semibold uppercase tracking-[0.12em] text-slate-700" aria-label="Chart legend">
          <span>Solid — questions</span><span>Dashed — provider failures</span>
        </div>
      </div>
      <ol className="divide-y divide-slate-300 border-y-2 border-slate-700 text-sm">
        {chronological.map((row) => (
          <li key={`${row.day}-${row.jurisdictionCode}`} className="grid grid-cols-[6rem_1fr] gap-4 py-3">
            <time dateTime={row.day} className="font-semibold">{dayLabel(row.day)}</time>
            <span>{`${row.totalQuestions.toLocaleString("en-US")} questions, ${row.failureCount.toLocaleString("en-US")} provider ${row.failureCount === 1 ? "failure" : "failures"}, ${row.noResultCount.toLocaleString("en-US")} empty results, p95 ${row.p95LatencyMs.toLocaleString("en-US")} ms`}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
