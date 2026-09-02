"use client";

import { api } from "../../../convex/_generated/api";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { PermissionBoundary } from "./permission-boundary";
import { StepUpDialog } from "./step-up-dialog";

type Decision = {
  decision: "approve" | "reject";
  reviewerId: string;
  reason: string;
  evaluationRunId?: string;
  createdAt: number;
};
export type ReviewItem = {
  id: string;
  resourceTitle: string;
  officialCitation: string;
  versionNumber: number;
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  sourceHost: string;
  effectiveDate?: string;
  status: "ready_for_review" | "approved" | "published" | "superseded";
  submittedBy: string;
  submittedAt?: number;
  previousVersion?: { versionNumber: number; filename: string; sha256: string; effectiveDate?: string };
  decisions: Decision[];
};

type HighRiskAction = "publish" | "unpublish" | "rollback";

function actionKey(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function DocumentReview({ items }: { items: readonly ReviewItem[] }) {
  const router = useRouter();
  const approve = useMutation(api.admin.reviews.approveVersion);
  const reject = useMutation(api.admin.reviews.rejectVersion);
  const publish = useMutation(api.admin.publication.publishVersion);
  const unpublish = useMutation(api.admin.publication.unpublishVersion);
  const rollback = useMutation(api.admin.publication.rollbackVersion);
  const [message, setMessage] = useState("");
  const [risk, setRisk] = useState<{ item: ReviewItem; action: HighRiskAction; key: string } | null>(null);

  async function decide(event: FormEvent<HTMLFormElement>, item: ReviewItem, decision: "approve" | "reject") {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const checklistAnswers = {
      sourceAuthentic: data.get("sourceAuthentic") === "on",
      metadataAccurate: data.get("metadataAccurate") === "on",
      extractionReviewed: data.get("extractionReviewed") === "on",
      citationsVerified: data.get("citationsVerified") === "on",
      evaluationPassed: data.get("evaluationPassed") === "on",
    };
    const mutation = decision === "approve" ? approve : reject;
    await mutation({
      versionId: item.id as never,
      checklistAnswers,
      evaluationRunId: String(data.get("evaluationRunId") ?? ""),
      reason: String(data.get("reason") ?? ""),
      idempotencyKey: actionKey(decision),
    });
    setMessage(`Version ${item.versionNumber} ${decision === "approve" ? "approved" : "rejected"}.`);
    router.refresh();
  }

  async function confirmRisk(input: { reason: string; confirmation?: string }) {
    if (!risk) return;
    const mutation = risk.action === "publish" ? publish : risk.action === "unpublish" ? unpublish : rollback;
    await mutation({
      versionId: risk.item.id as never,
      confirmation: input.confirmation ?? "",
      reason: input.reason,
      idempotencyKey: risk.key,
    });
    setMessage(`${risk.action[0].toUpperCase()}${risk.action.slice(1)} queued for version ${risk.item.versionNumber}.`);
  }

  if (items.length === 0) {
    return <p role="status" className="border-y border-[oklch(74%_0.028_78)] py-10 text-sm">The review docket is clear. New submissions will appear here when their metadata is ready.</p>;
  }

  return (
    <div className="space-y-12">
      {message ? <p role="status" className="border-y border-[oklch(55%_0.08_145)] bg-[oklch(94%_0.03_145)] px-4 py-3 text-sm font-semibold">{message}</p> : null}
      {items.map((item) => (
        <article key={item.id} className="border-t-2 border-[oklch(31%_0.05_252)] pt-6">
          <header className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[oklch(43%_0.065_67)]">Review docket / Version {item.versionNumber}</p>
              <h2 className="mt-2 text-[clamp(1.6rem,4vw,2.7rem)] font-semibold leading-tight tracking-[-0.04em]">{item.resourceTitle}</h2>
              <p className="mt-2 text-sm text-[oklch(40%_0.035_252)]">{item.officialCitation}</p>
            </div>
            <span className="w-fit border border-[oklch(61%_0.075_68)] bg-[oklch(92%_0.045_76)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em]">{item.status.replaceAll("_", " ")}</span>
          </header>

          <div className="mt-7 grid gap-8 xl:grid-cols-[1.15fr_.85fr]">
            <div className="space-y-8">
              <section aria-labelledby={`${item.id}-original`}>
                <h3 id={`${item.id}-original`} className="text-sm font-semibold uppercase tracking-[0.14em]">Authoritative original</h3>
                <dl className="mt-3 grid gap-x-6 gap-y-4 border-y border-[oklch(75%_0.025_78)] py-5 sm:grid-cols-2">
                  <div><dt className="text-xs font-semibold">File</dt><dd className="mt-1 break-all text-sm">{item.filename} / {item.mimeType} / {item.byteSize.toLocaleString()} bytes</dd></div>
                  <div><dt className="text-xs font-semibold">Official source host</dt><dd className="mt-1 text-sm">{item.sourceHost}</dd></div>
                  <div className="sm:col-span-2"><dt className="text-xs font-semibold">Checksum</dt><dd className="mt-1 break-all text-sm">SHA-256 {item.sha256}</dd></div>
                </dl>
              </section>
              <section aria-labelledby={`${item.id}-diff`}>
                <h3 id={`${item.id}-diff`} className="text-sm font-semibold uppercase tracking-[0.14em]">Metadata-only version diff</h3>
                <p className="mt-2 text-xs text-[oklch(43%_0.035_252)]">Original file bodies are never loaded by this comparison.</p>
                <dl className="mt-3 grid grid-cols-[auto_1fr_1fr] gap-x-4 gap-y-2 text-sm">
                  <dt className="font-semibold">Version</dt><dd>{item.previousVersion?.versionNumber ?? "None"}</dd><dd>{item.versionNumber}</dd>
                  <dt className="font-semibold">Filename</dt><dd className="break-all">{item.previousVersion?.filename ?? "None"}</dd><dd className="break-all">{item.filename}</dd>
                  <dt className="font-semibold">Effective</dt><dd>{item.previousVersion?.effectiveDate ?? "Not set"}</dd><dd>{item.effectiveDate ?? "Not set"}</dd>
                  <dt className="font-semibold">Checksum</dt>
                  <dd className="break-all">{item.previousVersion ? `Previous SHA-256 ${item.previousVersion.sha256}` : "No previous checksum"}</dd>
                  <dd className="break-all">Current SHA-256 {item.sha256}</dd>
                </dl>
                <p className="mt-3 text-sm font-semibold">{item.previousVersion?.sha256 === item.sha256 ? "Unchanged" : "Changed"}</p>
              </section>
              <section aria-labelledby={`${item.id}-decisions`}>
                <h3 id={`${item.id}-decisions`} className="text-sm font-semibold uppercase tracking-[0.14em]">Immutable decisions and evaluations</h3>
                {item.decisions.length ? <ol className="mt-3 space-y-3">{item.decisions.map((decision) => <li key={`${decision.reviewerId}-${decision.createdAt}`} className="border-l-2 border-amber-700 pl-4 text-sm"><strong>{decision.decision.toUpperCase()}</strong> / {decision.evaluationRunId ?? "No evaluation"}<p className="mt-1">{decision.reason}</p></li>)}</ol> : <p className="mt-3 text-sm">No decision has been recorded.</p>}
              </section>
            </div>

            <aside className="border-l border-[oklch(75%_0.025_78)] pl-0 xl:pl-7" aria-label={`Actions for version ${item.versionNumber}`}>
              {item.status === "ready_for_review" ? (
                <PermissionBoundary resource="document" action="review" fallback={<p className="text-sm">Read-only review evidence. Your role cannot record a decision.</p>}>
                  <form onSubmit={(event) => {
                    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
                    void decide(event, item, submitter?.value === "reject" ? "reject" : "approve");
                  }} className="grid gap-4">
                    <fieldset className="grid gap-3"><legend className="mb-2 font-semibold">Required review record</legend>
                      {[["sourceAuthentic", "Official source authenticated"], ["metadataAccurate", "Metadata is accurate"], ["extractionReviewed", "Original text reviewed"], ["citationsVerified", "Citations verified"], ["evaluationPassed", "Search evaluation passed"]].map(([name, label]) => <label key={name} className="flex min-h-11 items-center gap-3 text-sm"><input name={name} type="checkbox" className="h-5 w-5 accent-amber-700" />{label}</label>)}
                    </fieldset>
                    <label className="grid gap-2 text-sm font-semibold">Evaluation run ID<input name="evaluationRunId" required maxLength={128} className="min-h-11 border border-[oklch(62%_0.035_252)] bg-transparent px-3 font-normal" /></label>
                    <label className="grid gap-2 text-sm font-semibold">Decision reason<textarea name="reason" required minLength={3} maxLength={500} rows={4} className="border border-[oklch(62%_0.035_252)] bg-transparent p-3 font-normal" /></label>
                    <div className="flex flex-wrap gap-3"><button type="submit" name="decision" value="approve" className="min-h-11 bg-[oklch(28%_0.055_252)] px-4 text-sm font-semibold text-[oklch(97%_0.012_82)]">Approve version</button><button type="submit" name="decision" value="reject" className="min-h-11 px-4 text-sm font-semibold underline decoration-2 decoration-amber-700 underline-offset-4">Reject version</button></div>
                  </form>
                </PermissionBoundary>
              ) : (
                <PermissionBoundary resource="document" action={item.status === "superseded" ? "rollback" : "publish"} fallback={<p className="text-sm">Read-only review evidence. Your role cannot change publication state.</p>}>
                  <button type="button" onClick={() => setRisk({ item, action: item.status === "approved" ? "publish" : item.status === "published" ? "unpublish" : "rollback", key: actionKey(item.status) })} className="min-h-11 bg-[oklch(28%_0.055_252)] px-4 text-sm font-semibold text-[oklch(97%_0.012_82)]">{item.status === "approved" ? "Publish version" : item.status === "published" ? "Unpublish version" : "Roll back to version"}</button>
                </PermissionBoundary>
              )}
            </aside>
          </div>
        </article>
      ))}
      {risk ? <StepUpDialog open title={`${risk.action[0].toUpperCase()}${risk.action.slice(1)} version ${risk.item.versionNumber}`} description="This changes the production legal-search index. Verify your password and record an operational reason." submitLabel={`Queue ${risk.action}`} targetId={risk.item.id} idempotencyKey={risk.key} stepUpAction={`document_${risk.action}`} confirmationPhrase={`${risk.action.toUpperCase()} ${risk.item.id}`} onClose={() => setRisk(null)} onConfirmed={confirmRisk} /> : null}
    </div>
  );
}
