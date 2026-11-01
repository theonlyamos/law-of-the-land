"use client";

import type { FunctionArgs } from "convex/server";
import type { ReactNode } from "react";
import { api } from "../../../convex/_generated/api";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { PermissionBoundary } from "./permission-boundary";
import { StepUpDialog } from "./step-up-dialog";

type Decision = {
  decision: "approve" | "reject";
  reviewerId: string;
  reason: string;
  evaluationRunId?: string;
  createdAt: number;
};
type SourceClass = "official_hosted" | "corroborated_reproduction";
type SourceVerification = {
  sourceClass: SourceClass;
  sourceUrl: string;
  verificationNotes: string;
  corroboratingUrls: string[];
  completeOriginal: boolean;
  citationChecked: boolean;
  laterTreatmentChecked: boolean;
};
type SourceVerificationRecord = SourceVerification & {
  kind: "approval" | "correction";
  assessment: "verified" | "unresolved";
  createdAt: number;
  reviewerId: string;
  reason: string;
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
  sourceProvenance?: string;
  sourceUrl?: string;
  caseAliases?: string[];
  sourceVerifications?: SourceVerificationRecord[];
  requiresSourceVerification?: boolean;
  effectiveDate?: string;
  status: "ready_for_review" | "approved" | "publishing" | "published" | "superseded" | "unpublished" | "rejected";
  failureSummary?: string;
  submittedBy: string;
  submittedAt?: number;
  previousVersion?: { versionNumber: number; filename: string; sha256: string; effectiveDate?: string };
  decisions: Decision[];
};

type HighRiskAction = "publish" | "unpublish" | "rollback";

function actionKey(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

type ReviewActions = {
  approve: (args: FunctionArgs<typeof api.admin.reviews.approveVersion>) => Promise<unknown>;
  reject: (args: FunctionArgs<typeof api.admin.reviews.rejectVersion>) => Promise<unknown>;
  publish: (args: FunctionArgs<typeof api.admin.publication.publishVersion>) => Promise<unknown>;
  unpublish: (args: FunctionArgs<typeof api.admin.publication.unpublishVersion>) => Promise<unknown>;
  rollback: (args: FunctionArgs<typeof api.admin.publication.rollbackVersion>) => Promise<unknown>;
  correct?: (args: FunctionArgs<typeof api.admin.sourceVerification.recordCorrection>) => Promise<unknown>;
};

class SourceEvidenceError extends Error {}

function requiresSourceEvidence(item: ReviewItem): boolean {
  return item.requiresSourceVerification === true || !!item.sourceProvenance;
}

function sourceEvidence(data: FormData, requireComplete = true): SourceVerification {
  const sourceClass = String(data.get("sourceClass") ?? "");
  if (sourceClass !== "official_hosted" && sourceClass !== "corroborated_reproduction") throw new SourceEvidenceError("Choose how this source was verified.");
  const sourceUrl = String(data.get("sourceUrl") ?? "").trim();
  const verificationNotes = String(data.get("verificationNotes") ?? "").trim();
  const corroboratingUrls = String(data.get("corroboratingUrls") ?? "").split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
  const validUrl = (value: string) => {
    try { const url = new URL(value); return value.length <= 500 && url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
  };
  if (!validUrl(sourceUrl) || corroboratingUrls.length > 10 || corroboratingUrls.some((url) => !validUrl(url))) throw new SourceEvidenceError("Use complete HTTPS source and corroborating URLs without credentials (up to 10 corroborating URLs).");
  if (verificationNotes.length < 20 || verificationNotes.length > 2000) throw new SourceEvidenceError("Describe the verification evidence in 20–2,000 characters.");
  const host = (url: string) => new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  if (requireComplete && sourceClass === "corroborated_reproduction" && !corroboratingUrls.some((url) => host(url) !== host(sourceUrl))) throw new SourceEvidenceError("A reproduced judgment needs at least one independent corroborating source on a different host.");
  const completeOriginal = data.get("completeOriginal") === "on";
  const citationChecked = data.get("citationChecked") === "on";
  const laterTreatmentChecked = data.get("laterTreatmentChecked") === "on";
  if (requireComplete && (!completeOriginal || !citationChecked || !laterTreatmentChecked)) throw new SourceEvidenceError("Verify the complete original, citation, and later treatment before recording source evidence. Leave unresolved documents unpublished.");
  return { sourceClass, sourceUrl, verificationNotes, corroboratingUrls, completeOriginal, citationChecked, laterTreatmentChecked };
}

function SourceEvidenceFields({ sourceUrl, authenticityAssertion = false, allowUnresolved = false }: { sourceUrl?: string; authenticityAssertion?: boolean; allowUnresolved?: boolean }) {
  const [sourceClass, setSourceClass] = useState("");
  return <fieldset className="grid gap-4 border-y border-[oklch(75%_0.025_78)] py-5">
    <legend className="font-semibold">Source verification evidence</legend>
    <label className="grid gap-2 text-sm font-semibold">Source classification<select name="sourceClass" required value={sourceClass} onChange={(event) => setSourceClass(event.target.value)} className="min-h-11 border bg-transparent px-3 font-normal"><option value="">Choose source classification</option><option value="official_hosted">Officially hosted original</option><option value="corroborated_reproduction">{allowUnresolved ? "Reproduction requiring verification" : "Independently corroborated reproduction"}</option></select></label>
    <label className="grid gap-2 text-sm font-semibold">Actual source URL<input name="sourceUrl" type="url" required readOnly={!!sourceUrl} maxLength={500} defaultValue={sourceUrl ?? ""} className="min-h-11 border bg-transparent px-3 font-normal" /></label>
    <label className="grid gap-2 text-sm font-semibold">Verification notes<textarea name="verificationNotes" required minLength={20} maxLength={2000} rows={4} className="border bg-transparent p-3 font-normal" /></label>
    <label className="grid gap-2 text-sm font-semibold">Corroborating URLs (one per line)<textarea name="corroboratingUrls" required={!allowUnresolved && sourceClass === "corroborated_reproduction"} rows={3} className="border bg-transparent p-3 font-normal" /></label>
    <p className="text-sm">For a reproduction, cite an independent source on another host and explain the comparison. Record the actual host without describing a law-firm copy as government-hosted or certified.</p>
    {[["completeOriginal", "Complete original verified"], ["citationChecked", "Case citation checked against the source"], ["laterTreatmentChecked", "Later treatment checked and recorded in the notes"]].map(([name, label]) => <label key={name} className="flex min-h-11 items-center gap-3 text-sm"><input key={`${sourceClass}:${name}`} name={name} type="checkbox" className="h-5 w-5 accent-amber-700" />{label}</label>)}
    {authenticityAssertion ? <label className="flex min-h-11 items-center gap-3 text-sm"><input key={sourceClass} name="sourceAuthentic" type="checkbox" disabled={!sourceClass} className="h-5 w-5 accent-amber-700" />{sourceClass === "corroborated_reproduction" ? "Reproduction authenticity independently corroborated" : sourceClass === "official_hosted" ? "Official source authenticated" : "Source authenticity verified (choose a source class)"}</label> : null}
  </fieldset>;
}

function SourceCorrection({ item, record, onRecorded }: { item: ReviewItem; record: NonNullable<ReviewActions["correct"]>; onRecorded(): void }) {
  const busy = useRef(false);
  const request = useRef<{ payload: string; key: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [open, setOpen] = useState(false);
  const [assessment, setAssessment] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    const form = event.currentTarget;
    busy.current = true; setPending(true); setMessage("");
    try {
      const data = new FormData(form);
      if (assessment !== "verified" && assessment !== "unresolved") throw new SourceEvidenceError("Choose the correction assessment.");
      const sourceVerification = sourceEvidence(data, assessment === "verified");
      const reason = String(data.get("reason") ?? "").trim();
      if (reason.length < 3 || reason.length > 500) throw new SourceEvidenceError("Record a correction reason in 3–500 characters.");
      const payload = JSON.stringify({ versionId: item.id, sourceVerification, assessment, reason });
      if (request.current?.payload !== payload) request.current = { payload, key: actionKey("source_correction") };
      await record({ versionId: item.id as never, sourceVerification, assessment, reason, idempotencyKey: request.current.key });
      form.reset(); request.current = null; setAssessment(""); setOpen(false);
      setMessage("Source correction recorded. Prior assertions and audit records are preserved."); onRecorded();
    } catch (error) {
      setMessage(error instanceof SourceEvidenceError ? error.message : "The source correction could not be recorded. Check the evidence and your access, then retry.");
    } finally { busy.current = false; setPending(false); }
  }
  return <section className="mt-6 border-t pt-5"><button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="min-h-11 font-semibold underline underline-offset-4">Record source correction</button>
    {open ? <div><p className="mt-3 text-sm">{item.status === "superseded" ? "This appends complete verified source evidence and preserves earlier assertions and audit history. It does not change this superseded version's lifecycle state or roll back to it. Use the separate guarded rollback action after the evidence is recorded. Unresolved evidence cannot be recorded for a superseded version." : "This appends evidence and preserves earlier assertions and audit history. It does not approve or publish a version. If authenticity, completeness, citation, or later treatment remains unresolved, unpublish the document through the guarded action above before recording a correction."}</p>
    <form onSubmit={(event) => { void submit(event); }} className="mt-4 grid gap-4">
      <fieldset disabled={pending} className="grid gap-4">
        <label className="grid gap-2 text-sm font-semibold">Correction assessment<select name="assessment" required value={assessment} onChange={(event) => setAssessment(event.target.value)} className="min-h-11 border bg-transparent px-3 font-normal"><option value="">Choose assessment</option>{["approved", "published", "superseded"].includes(item.status) ? <option value="verified">Verified evidence</option> : null}{["approved", "unpublished", "rejected", "ready_for_review"].includes(item.status) ? <option value="unresolved">Unresolved - remains unpublished</option> : null}</select></label>
        {item.status === "approved" && assessment === "unresolved" ? <p className="text-sm">Recording unresolved evidence withdraws the current approval and returns this version for fresh review. Earlier decisions remain in the audit history.</p> : null}
        <SourceEvidenceFields sourceUrl={item.sourceUrl} allowUnresolved={assessment === "unresolved"} />
        <label className="grid gap-2 text-sm font-semibold">Correction reason<textarea name="reason" required minLength={3} maxLength={500} rows={3} className="border bg-transparent p-3 font-normal" /></label>
        <button type="submit" className="min-h-11 border px-4 text-sm font-semibold">{pending ? "Recording correction…" : "Append source correction"}</button>
      </fieldset>
    </form></div> : null}
    {message ? <p role="status" className="mt-3 text-sm">{message}</p> : null}
  </section>;
}
function ReviewPermission({ scoped, allowed, ...props }: { scoped: boolean; allowed?: boolean; resource: string; action: string; fallback?: ReactNode; children: ReactNode }) {
  return scoped ? allowed ? props.children : props.fallback : <PermissionBoundary {...props} />;
}
export function DocumentReview({ items, onPublicationQueued, actions, canReview, operationsHref = "/admin/operations" }: { items: readonly ReviewItem[]; onPublicationQueued?: () => void; actions?: ReviewActions; canReview?: boolean; operationsHref?: string }) {
  const router = useRouter();
  const adminapprove = useMutation(api.admin.reviews.approveVersion);
  const adminreject = useMutation(api.admin.reviews.rejectVersion);
  const adminpublish = useMutation(api.admin.publication.publishVersion);
  const adminunpublish = useMutation(api.admin.publication.unpublishVersion);
  const adminrollback = useMutation(api.admin.publication.rollbackVersion);
  const admincorrect = useMutation(api.admin.sourceVerification.recordCorrection);
  const { approve, reject, publish, unpublish, rollback } = actions ?? { approve: adminapprove, reject: adminreject, publish: adminpublish, unpublish: adminunpublish, rollback: adminrollback };
  const [message, setMessage] = useState("");
  const [risk, setRisk] = useState<{ item: ReviewItem; action: HighRiskAction; key: string } | null>(null);
  const decisionLocks = useRef(new Set<string>());
  const decisionRequests = useRef(new Map<string, { payload: string; key: string }>());
  const [pendingDecisions, setPendingDecisions] = useState<Set<string>>(new Set());

  async function decide(event: FormEvent<HTMLFormElement>, item: ReviewItem, decision: "approve" | "reject") {
    event.preventDefault();
    if (decisionLocks.current.has(item.id)) return;
    const data = new FormData(event.currentTarget);
    const checklistAnswers = {
      sourceAuthentic: data.get("sourceAuthentic") === "on",
      metadataAccurate: data.get("metadataAccurate") === "on",
      extractionReviewed: data.get("extractionReviewed") === "on",
      citationsVerified: data.get("citationsVerified") === "on",
      evaluationPassed: data.get("evaluationPassed") === "on",
    };
    const sourceVerification = decision === "approve" && requiresSourceEvidence(item) ? sourceEvidence(data) : undefined;
    if (decision === "approve" && Object.values(checklistAnswers).some((answer) => !answer)) throw new SourceEvidenceError("Complete each required review assertion after verifying its evidence.");
    const input = {
      versionId: item.id as never,
      checklistAnswers,
      evaluationRunId: String(data.get("evaluationRunId") ?? ""),
      reason: String(data.get("reason") ?? ""),
      ...(sourceVerification ? { sourceVerification } : {}),
    };
    const payload = JSON.stringify({ decision, ...input });
    if (decisionRequests.current.get(item.id)?.payload !== payload) decisionRequests.current.set(item.id, { payload, key: actionKey(decision) });
    decisionLocks.current.add(item.id); setPendingDecisions(new Set(decisionLocks.current));
    try {
      const mutation = decision === "approve" ? approve : reject;
      await mutation({ ...input, idempotencyKey: decisionRequests.current.get(item.id)!.key });
      decisionRequests.current.delete(item.id);
      setMessage(`Version ${item.versionNumber} ${decision === "approve" ? "approved" : "rejected"}.`);
      router.refresh();
    } finally { decisionLocks.current.delete(item.id); setPendingDecisions(new Set(decisionLocks.current)); }
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
    if (risk.action !== "unpublish") onPublicationQueued?.();
    router.refresh();
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
            <span className="w-fit border border-[oklch(61%_0.075_68)] bg-[oklch(92%_0.045_76)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em]">{item.status === "publishing" ? item.failureSummary ? "Publishing needs review" : "Queued for publishing" : item.status === "ready_for_review" ? "Unapproved" : item.status.replaceAll("_", " ")}</span>
          </header>

          <div className="mt-7 grid gap-8 xl:grid-cols-[1.15fr_.85fr]">
            <div className="space-y-8">
              <section aria-labelledby={`${item.id}-original`}>
                <h3 id={`${item.id}-original`} className="text-sm font-semibold uppercase tracking-[0.14em]">{item.sourceProvenance || item.sourceVerifications?.[0]?.sourceClass === "corroborated_reproduction" ? "Uploaded court text" : "Authoritative original"}</h3>
                <a href={`/api/admin/review-files/${encodeURIComponent(item.id)}`} target="_blank" rel="noopener noreferrer" aria-label={`View uploaded file for ${item.resourceTitle}, version ${item.versionNumber}`} className="mt-3 inline-block underline">View uploaded file</a>
                <dl className="mt-3 grid gap-x-6 gap-y-4 border-y border-[oklch(75%_0.025_78)] py-5 sm:grid-cols-2">
                  <div><dt className="text-xs font-semibold">File</dt><dd className="mt-1 break-all text-sm">{item.filename} / {item.mimeType} / {item.byteSize.toLocaleString()} bytes</dd></div>
                  <div><dt className="text-xs font-semibold">{item.sourceProvenance || item.sourceVerifications?.[0]?.sourceClass === "corroborated_reproduction" ? "Source host" : "Official source host"}</dt><dd className="mt-1 text-sm">{item.sourceHost}</dd></div>
                  <div className="sm:col-span-2"><dt className="text-xs font-semibold">Checksum</dt><dd className="mt-1 break-all text-sm">SHA-256 {item.sha256}</dd></div>
                </dl>
                {item.sourceProvenance ? <div className="mt-4 space-y-3 text-sm">
                  <h4 className="font-semibold">Recorded source provenance</h4>
                  <p className="whitespace-pre-wrap break-words">{item.sourceProvenance}</p>
                  {item.sourceUrl ? <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center break-all font-semibold underline underline-offset-4">Open recorded source</a> : null}
                  {item.caseAliases?.length ? <p className="break-words"><strong>Case aliases:</strong> {item.caseAliases.join("; ")}</p> : null}
                  <p>Recorded provenance is evidence for human review. Source authenticity and every other assertion still require verification.</p>
                </div> : null}
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
              <section aria-labelledby={`${item.id}-source-history`}>
                <h3 id={`${item.id}-source-history`} className="text-sm font-semibold uppercase tracking-[0.14em]">Append-only source verification history</h3>
                {item.sourceVerifications?.length ? <ol className="mt-3 space-y-4">{item.sourceVerifications.map((record, index) => <li key={`${record.reviewerId}-${record.createdAt}-${index}`} className="border-l-2 border-amber-700 pl-4 text-sm">
                  <p className="font-semibold">{record.kind === "correction" ? "Source correction" : "Approval evidence"} / {record.sourceClass === "official_hosted" ? "Officially hosted original" : record.assessment === "unresolved" ? "Reproduction - verification unresolved" : "Independently corroborated reproduction"} / {record.assessment}</p>
                  <p className="mt-2 whitespace-pre-wrap break-words">{record.verificationNotes}</p>
                  <p className="mt-2 break-words">Reason: {record.reason}</p>
                  <p className="mt-2">Recorded by {record.reviewerId} / {new Date(record.createdAt).toISOString()}</p>
                  <a href={record.sourceUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex min-h-11 items-center break-all underline underline-offset-4">{record.sourceUrl}</a>
                  {record.corroboratingUrls.length ? <ul>{record.corroboratingUrls.map((url, sourceIndex) => <li key={`${url}-${sourceIndex}`}><a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center break-all underline underline-offset-4">{url}</a></li>)}</ul> : null}
                  <p>Complete original: {record.completeOriginal ? "verified" : "unresolved"}; citation: {record.citationChecked ? "checked" : "unresolved"}; later treatment: {record.laterTreatmentChecked ? "checked" : "unresolved"}.</p>
                </li>)}</ol> : <p className="mt-3 text-sm">No structured source verification is recorded. Earlier review decisions remain unchanged.</p>}
              </section>
            </div>

            <aside className="border-l border-[oklch(75%_0.025_78)] pl-0 xl:pl-7" aria-label={`Actions for version ${item.versionNumber}`}>
              {item.status === "ready_for_review" ? (
                <ReviewPermission scoped={!!actions} allowed={canReview} resource="document" action="review" fallback={<p className="text-sm">Read-only review evidence. Your role cannot record a decision.</p>}>
                  <form onSubmit={(event) => {
                    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
                    void decide(event, item, submitter?.value === "reject" ? "reject" : "approve").catch((error) => setMessage(error instanceof SourceEvidenceError ? error.message : "The decision could not be recorded. Check the review fields and your access, then try again."));
                  }} className="grid gap-4">
                    {requiresSourceEvidence(item) ? <SourceEvidenceFields sourceUrl={item.sourceUrl} authenticityAssertion /> : null}
                    <fieldset className="grid gap-3"><legend className="mb-2 font-semibold">Required review record</legend>
                      {[...(!requiresSourceEvidence(item) ? [["sourceAuthentic", "Official source authenticated"]] : []), ["metadataAccurate", "Metadata is accurate"], ["extractionReviewed", "Original text reviewed"], ["citationsVerified", "Citations verified"], ["evaluationPassed", "Search evaluation passed"]].map(([name, label]) => <label key={name} className="flex min-h-11 items-center gap-3 text-sm"><input name={name} type="checkbox" className="h-5 w-5 accent-amber-700" />{label}</label>)}
                    </fieldset>
                    <label className="grid gap-2 text-sm font-semibold">Evaluation run ID<input name="evaluationRunId" required maxLength={128} className="min-h-11 border border-[oklch(62%_0.035_252)] bg-transparent px-3 font-normal" /></label>
                    <label className="grid gap-2 text-sm font-semibold">Decision reason<textarea name="reason" required minLength={3} maxLength={500} rows={4} className="border border-[oklch(62%_0.035_252)] bg-transparent p-3 font-normal" /></label>
                    <div className="flex flex-wrap gap-3"><button type="submit" name="decision" value="approve" disabled={pendingDecisions.has(item.id)} className="min-h-11 bg-[oklch(28%_0.055_252)] px-4 text-sm font-semibold text-[oklch(97%_0.012_82)]">Approve version</button><button type="submit" name="decision" value="reject" formNoValidate disabled={pendingDecisions.has(item.id)} className="min-h-11 px-4 text-sm font-semibold underline decoration-2 decoration-amber-700 underline-offset-4">Reject version</button></div>
                  </form>
                </ReviewPermission>
              ) : item.status === "publishing" ? (
                <div className="space-y-3 text-sm" role="status">
                  <p>{item.failureSummary ?? "Publication is queued or indexing is in progress. The document will be published once Gemini confirms indexing."}</p>
                  <a href={operationsHref} className="font-semibold underline underline-offset-4">View publishing jobs</a>
                </div>
              ) : item.status === "unpublished" || item.status === "rejected" ? <p className="text-sm">This version is unpublished. Source corrections do not make it searchable.</p> : (
                <ReviewPermission scoped={!!actions} allowed={canReview} resource="document" action={item.status === "superseded" ? "rollback" : "publish"} fallback={<p className="text-sm">Read-only review evidence. Your role cannot change publication state.</p>}>
                  <button type="button" onClick={() => setRisk({ item, action: item.status === "approved" ? "publish" : item.status === "published" ? "unpublish" : "rollback", key: actionKey(item.status) })} className="min-h-11 bg-[oklch(28%_0.055_252)] px-4 text-sm font-semibold text-[oklch(97%_0.012_82)]">{item.status === "approved" ? "Publish version" : item.status === "published" ? "Unpublish version" : "Roll back to version"}</button>
                </ReviewPermission>
              )}
              {["ready_for_review", "approved", "published", "superseded", "unpublished", "rejected"].includes(item.status) && (!actions || actions.correct) ? <ReviewPermission scoped={!!actions} allowed={canReview} resource="document" action="review">
                {item.status === "superseded" ? <PermissionBoundary resource="document" action="rollback"><SourceCorrection item={item} record={actions?.correct ?? admincorrect} onRecorded={() => router.refresh()} /></PermissionBoundary> : <SourceCorrection item={item} record={actions?.correct ?? admincorrect} onRecorded={() => router.refresh()} />}
              </ReviewPermission> : null}
            </aside>
          </div>
        </article>
      ))}
      {risk ? <StepUpDialog open title={`${risk.action[0].toUpperCase()}${risk.action.slice(1)} version ${risk.item.versionNumber}`} description={risk.action === "publish" ? "This makes this version available in legal search. Confirm publication and record an operational reason." : "This changes the production legal-search index. Verify your password and record an operational reason."} submitLabel={`Queue ${risk.action}`} cancelLabel="Cancel" targetId={risk.item.id} idempotencyKey={risk.key} stepUpAction={risk.action === "publish" ? undefined : `document_${risk.action}`} confirmationPhrase={`${risk.action.toUpperCase()} ${risk.item.id}`} acknowledgement={risk.action === "publish" ? "I confirm this is the version I intend to publish." : undefined} onClose={() => setRisk(null)} onConfirmed={confirmRisk} /> : null}
    </div>
  );
}
