"use client";

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { makeFunctionReference } from "convex/server";
import { useQuery } from "convex/react";
import type { AnalyticsMetric } from "./analytics-chart-plot";

const AnalyticsChartPlot = lazy(() => import("./analytics-chart-plot"));
const listDailyMetrics = makeFunctionReference<
  "query",
  { paginationOpts: { numItems: number; cursor: string | null }; jurisdictionId: string | null; fromDay: string; toDay: string },
  { page: AnalyticsMetric[]; isDone: boolean; continueCursor: string }
>("admin/analytics:listDailyMetrics");

export function AnalyticsCharts({ jurisdictionId, fromDay, toDay }: { jurisdictionId: string | null; fromDay: string; toDay: string }) {
  const section = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const result = useQuery(
    listDailyMetrics,
    visible
      ? { paginationOpts: { numItems: 50, cursor: null }, jurisdictionId, fromDay, toDay }
      : "skip",
  );

  useEffect(() => {
    const node = section.current;
    if (!node) return;
    if (!("IntersectionObserver" in globalThis)) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setVisible(true);
      observer.disconnect();
    }, { rootMargin: "160px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <section ref={section} aria-labelledby="analytics-trends-heading" className="mt-12 [content-visibility:auto] [contain-intrinsic-size:520px]">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3 border-b border-slate-400 pb-3">
        <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-800">Aggregate register</p><h2 id="analytics-trends-heading" className="mt-1 font-serif text-3xl font-semibold">Daily signal</h2></div>
        <p className="max-w-md text-sm leading-6 text-slate-700">UTC totals only. No questions, prompts, retrieved passages, answers, or provider messages enter this view.</p>
      </div>
      {visible && result ? (
        <Suspense fallback={<p role="status" className="min-h-52 py-10 text-sm text-slate-700">Preparing aggregate charts…</p>}>
          <AnalyticsChartPlot metrics={result.page} />
        </Suspense>
      ) : visible ? (
        <p role="status" className="min-h-52 border-y border-dashed border-slate-400 py-10 text-sm text-slate-700">Loading aggregate chart data…</p>
      ) : (
        <p role="status" className="min-h-52 border-y border-dashed border-slate-400 py-10 text-sm text-slate-700">Charts load when this section enters view.</p>
      )}
    </section>
  );
}
