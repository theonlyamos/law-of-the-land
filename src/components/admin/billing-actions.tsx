"use client";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";

const LONG_MS = 30 * 24 * 60 * 60 * 1_000;

export function BillingAllowanceSummary({ used, effectiveLimit, allowed, canRecord, override }: {
  used: number;
  effectiveLimit: number;
  allowed: boolean;
  canRecord: boolean;
  override: null | { limit: number; expiresAt: number; grantedBy: string; reason: string };
}) {
  return <div className="grid gap-1">
    <span className="font-semibold">{used} / {effectiveLimit}</span>
    <span className="text-xs">{canRecord ? "Another question can be recorded" : allowed ? "At limit — another question cannot be recorded" : "Over limit — recording is blocked"}</span>
    {override ? <span className="text-xs">Override {override.limit} · Expires {new Date(override.expiresAt).toISOString()}<br />Granted by {override.grantedBy} · {override.reason}</span> : <span className="text-xs">No temporary override</span>}
  </div>;
}

export function BillingActions({ userId, activeOverrideId }: { userId: string; activeOverrideId?: Id<"quotaOverrides"> }) {
  const router = useRouter();
  const grant = useMutation(api.admin.billing.grantQuotaOverride);
  const revoke = useMutation(api.admin.billing.revokeQuotaOverride);
  const [limit, setLimit] = useState("100");
  const [expires, setExpires] = useState("");
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const numericLimit = Number(limit);
  const expiresAt = Date.parse(expires);
  const exceptional = useMemo(() => numericLimit > 1_000 || (Number.isFinite(expiresAt) && expiresAt - Date.now() > LONG_MS), [numericLimit, expiresAt]);
  const expected = `CONFIRM_QUOTA_OVERRIDE ${userId}`;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (exceptional && confirmation !== expected) { setState("error"); return; }
    setState("saving");
    try {
      await grant({ userId, limit: numericLimit, startsAt: Date.now(), expiresAt, reason, confirmation, idempotencyKey: crypto.randomUUID() });
      setState("saved");
      router.refresh();
    } catch { setState("error"); }
  }

  async function revokeCurrent() {
    if (!activeOverrideId || reason.trim().length < 3) { setState("error"); return; }
    setState("saving");
    try { await revoke({ overrideId: activeOverrideId, reason, idempotencyKey: crypto.randomUUID() }); setState("saved"); router.refresh(); } catch { setState("error"); }
  }

  return (
    <details className="border-t border-[oklch(78%_0.025_78)] pt-3">
      <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold underline decoration-amber-700 decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700">Adjust temporary allowance</summary>
      <form onSubmit={submit} className="grid gap-4 bg-[oklch(97%_0.012_82)] p-4 sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-semibold">Effective question limit<input aria-label="Effective question limit" inputMode="numeric" min="1" max="10000" required type="number" value={limit} onChange={(event) => setLimit(event.target.value)} className="min-h-11 border border-slate-400 bg-white px-3" /></label>
        <label className="grid gap-1 text-sm font-semibold">Expires<input aria-label="Expires" required type="datetime-local" value={expires} onChange={(event) => setExpires(event.target.value)} className="min-h-11 border border-slate-400 bg-white px-3" /></label>
        <label className="grid gap-1 text-sm font-semibold sm:col-span-2">Reason<textarea aria-label="Reason" required minLength={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} className="min-h-24 border border-slate-400 bg-white p-3" /></label>
        {exceptional ? <label className="grid gap-1 text-sm font-semibold sm:col-span-2">Type {expected} to continue<input aria-label={`Type ${expected} to continue`} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="min-h-11 border border-amber-700 bg-amber-50 px-3" /></label> : null}
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <button disabled={state === "saving"} className="min-h-11 bg-[oklch(29%_0.055_252)] px-4 font-semibold text-[oklch(97%_0.012_82)] disabled:opacity-50" type="submit">Grant temporary override</button>
          {activeOverrideId ? <button disabled={state === "saving"} className="min-h-11 border border-red-800 px-4 font-semibold text-red-900 disabled:opacity-50" type="button" onClick={revokeCurrent}>Revoke active override</button> : null}
          <span aria-live="polite" className="text-sm">{state === "saved" ? "Allowance updated." : state === "error" ? "The allowance was not changed. Check the values and confirmation." : state === "saving" ? "Saving…" : ""}</span>
        </div>
      </form>
    </details>
  );
}
