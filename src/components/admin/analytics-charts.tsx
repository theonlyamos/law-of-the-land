"use client";

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { AnalyticsMetric } from "./analytics-chart-plot";

const AnalyticsChartPlot = lazy(() => import("./analytics-chart-plot"));

export function AnalyticsCharts({ metrics }: { metrics: readonly AnalyticsMetric[] }) {
  const section = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);

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
      {visible ? (
        <Suspense fallback={<p role="status" className="min-h-52 py-10 text-sm text-slate-700">Preparing aggregate charts…</p>}>
          <AnalyticsChartPlot metrics={metrics} />
        </Suspense>
      ) : (
        <p role="status" className="min-h-52 border-y border-dashed border-slate-400 py-10 text-sm text-slate-700">Charts load when this section enters view.</p>
      )}
    </section>
  );
}
