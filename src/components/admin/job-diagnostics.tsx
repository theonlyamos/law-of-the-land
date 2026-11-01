"use client";

import { useAction } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

type Inspection = FunctionReturnType<typeof api.admin.geminiDiagnosticActions.inspectIndexJobForAdmin>;

/** Explicit single-job provider reads only; deliberately separate from retry controls. */
export function JobDiagnostics({ jobId }: { jobId: Id<"integrationJobs"> }) {
  const inspect = useAction(api.admin.geminiDiagnosticActions.inspectIndexJobForAdmin);
  const [result, setResult] = useState<Inspection | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  async function run() {
    setState("loading");
    setResult(null);
    try { setResult(await inspect({ jobId })); setState("idle"); }
    catch { setState("error"); }
  }
  const documents = result?.provider.documents;
  const operation = result?.provider.operation;
  return <div className="mt-3 grid max-w-lg gap-2 text-xs">
    <button type="button" disabled={state === "loading"} onClick={() => void run()} className="min-h-11 border border-slate-700 px-3 text-sm font-semibold disabled:opacity-50">
      {state === "loading" ? "Inspecting…" : "Inspect indexing (read-only)"}
    </button>
    {state === "loading" ? <p role="status">Reading this job’s provider evidence. No state changes.</p> : null}
    {state === "error" ? <p role="alert" className="text-red-800">Inspection unavailable. Access, target eligibility, or provider reads could not be verified. No recovery was performed.</p> : null}
    {result && documents && operation ? <div role="status" className="space-y-1 break-words border border-slate-500 p-3">
      <p>Observed: {new Date(result.observedAt).toISOString()}</p>
      <p>Version: {result.detail.versionId}</p>
      <p>Resource: {result.detail.resourceId}</p>
      <p>Recovery kind: {result.detail.recoveryKind ?? "none"}</p>
      <p>Known operation: {result.detail.providerOperationName}</p>
      <p>Recorded error: {result.detail.lastErrorKind ?? "none"}</p>
      <p>Operation status: {operation.status} · Done: {operation.done === null ? "Unknown" : operation.done ? "Yes" : "No"}</p>
      <p>Operation error code: {operation.error?.code ?? "none"}</p>
      <p>Operation request error: {operation.requestError?.kind ?? "none"} {operation.requestError?.status ?? ""}</p>
      <p>Response document read error: {operation.response?.requestError?.kind ?? "none"} {operation.response?.requestError?.status ?? ""}</p>
      <p>Response metadata matched: {operation.response?.metadataMatched === true ? "Yes" : operation.response?.metadataMatched === false ? "No" : "Unknown"}</p>
      <p>Response document state: {operation.response?.document?.state ?? "Unknown"}</p>
      <p>Scan complete: {documents.scanComplete ? "Yes" : "No"}</p>
      <p>Pages: {documents.pagesScanned} · Documents: {documents.documentsScanned}</p>
      <p>Exact matches: {documents.matchingCount} · Duplicate matches: {documents.duplicateMatches ? "Yes" : "No"}</p>
      {documents.matches.map(match => <p key={match.reference}>Match: {match.reference} · {match.state}</p>)}
      <p>Scan bound: {documents.scanLimit ?? "none"}</p>
      <p>Scan error: {documents.requestError?.kind ?? "none"} {documents.requestError?.status ?? ""}</p>
      <p>Read-only observation, not recovery authorization. Incomplete scan is not publication proof.</p>
    </div> : null}
  </div>;
}
