"use client";

import { useState } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { DocumentReview, type ReviewItem } from "./document-review";

const stages = [
  ["ready_for_review", "Unapproved"],
  ["approved", "Approved"],
  ["publishing", "Queued for publishing"],
  ["published", "Published"],
  ["superseded", "Superseded"],
] as const;

export function ReviewDocket() {
  const [stage, setStage] = useState<ReviewItem["status"]>("ready_for_review");
  const counts = useQuery(api.admin.reviews.getReviewCounts, {});
  const { results, status, loadMore } = usePaginatedQuery(
    api.admin.reviews.listReviewQueue,
    { status: stage },
    { initialNumItems: 12 },
  );

  return (
    <div className="space-y-8">
      <div role="group" aria-label="Filter by document status" className="flex flex-wrap gap-2">
        {stages.map(([value, label]) => (
          <button key={value} type="button" aria-pressed={stage === value} onClick={() => setStage(value)}
            aria-label={counts != null ? `${label} (${counts[value] ?? 0})` : label}
            className={`min-h-11 border px-4 py-2 text-sm font-semibold ${stage === value ? "border-[oklch(28%_0.055_252)] bg-[oklch(28%_0.055_252)] text-[oklch(97%_0.012_82)]" : "border-[oklch(62%_0.035_252)] bg-transparent"}`}>
            {label}
            <span aria-hidden="true" className="ml-2 inline-block min-w-5 rounded-sm bg-current/10 px-1.5 text-xs tabular-nums">
              {counts != null ? counts[value] ?? 0 : "…"}
            </span>
          </button>
        ))}
      </div>
      <div aria-live="polite">
        {status === "LoadingFirstPage" ? <p role="status">Loading documents…</p> : results.length === 0 ? (
          <p role="status" className="border-y border-[oklch(74%_0.028_78)] py-10 text-sm">No documents in this stage.</p>
        ) : <DocumentReview items={results} onPublicationQueued={() => setStage("publishing")} />}
      </div>
      {status === "CanLoadMore" || status === "LoadingMore" ? (
        <button type="button" disabled={status === "LoadingMore"} onClick={() => loadMore(12)} className="min-h-11 border border-[oklch(62%_0.035_252)] px-4 text-sm font-semibold disabled:opacity-50">
          {status === "LoadingMore" ? "Loading…" : "Load more documents"}
        </button>
      ) : null}
    </div>
  );
}
