"use client";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { useState } from "react";

export function JobActions({ jobId, status, canRetry, canCancel }: { jobId: Id<"integrationJobs">; status: "queued" | "running" | "waiting_provider" | "succeeded" | "failed" | "cancelled" | "manual_review"; canRetry: boolean; canCancel: boolean }) {
  const retry = useMutation(api.admin.jobs.retryJob); const cancel = useMutation(api.admin.jobs.cancelJob);
  const [reason, setReason] = useState(""); const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const execute = async (kind: "retry" | "cancel") => { setState("working"); try { const idempotencyKey = `${kind}_${crypto.randomUUID().replaceAll("-", "")}`; await (kind === "retry" ? retry : cancel)({ jobId, reason, idempotencyKey }); setState("done"); } catch { setState("error"); } };
  const retryable = canRetry && (status === "failed" || status === "manual_review"); const cancellable = canCancel && status === "queued";
  if (!retryable && !cancellable) return <span className="text-xs text-slate-500">No safe transition</span>;
  return <div className="grid min-w-56 gap-2"><label className="text-xs font-semibold">Operator reason<input aria-label={`Reason for ${jobId}`} value={reason} onChange={(event) => setReason(event.target.value)} className="mt-1 min-h-11 w-full border border-slate-400 bg-white px-3 text-sm font-normal" /></label><div className="flex gap-2">{retryable ? <button disabled={reason.trim().length < 3 || state === 'working'} onClick={() => void execute('retry')} className="min-h-11 border border-slate-700 px-3 text-sm font-semibold">Retry safely</button> : null}{cancellable ? <button disabled={reason.trim().length < 3 || state === 'working'} onClick={() => void execute('cancel')} className="min-h-11 border border-amber-800 px-3 text-sm font-semibold">Cancel queued job</button> : null}</div>{state === 'error' ? <p role="alert" className="text-xs text-red-800">The authoritative transition was refused.</p> : null}{state === 'done' ? <p role="status" className="text-xs">Transition recorded.</p> : null}</div>;
}
