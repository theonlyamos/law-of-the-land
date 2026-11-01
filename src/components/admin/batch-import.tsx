"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useConvex, useMutation, useQuery_experimental as useQueryState } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { fingerprintFile, normalizeBatchIdentity, parseBatchManifest, type BatchImportEntry, type BatchManifest } from "@/lib/admin/batch-import";
import { buttonClass, fieldClass, labelClass, secondaryButtonClass } from "./form-styles";

type Result = {
  kind: "new" | "imported" | "existing" | "conflict";
  message: string;
  resourceId?: string;
  versionId?: string;
  status?: string;
  indexed: boolean;
};
type Progress = {
  phase: string;
  sha256?: string;
  byteSize?: number;
  storageId?: string;
  result?: Result;
  error?: string;
};
type SavedBatch = { manifest: BatchManifest; progress: Record<string, Progress> };
const finished = (row?: Progress) => row?.result?.kind === "imported" || row?.result?.kind === "existing";

function VersionStatus({ versionId }: { versionId: string }) {
  const state = useQueryState({ query: api.admin.batchImports.getStatus, args: { versionId: versionId as Id<"documentVersions"> } });
  if (state.status === "error") return <p role="alert">Live status unavailable. Open the document record to check.</p>;
  if (state.status !== "success") return <p>Loading live review and indexing status…</p>;
  const status = state.data;
  if (!status) return <p>Version unavailable.</p>;
  return <p>Review / publication: <strong>{status.status?.replaceAll("_", " ")}</strong>. Search index: <strong>{status.indexed ? "Indexed" : "Not confirmed"}</strong>.</p>;
}

export function BatchImport({ userId, maxBytes }: { userId: string; maxBytes: number }) {
  const client = useConvex();
  const generateUploadUrl = useMutation(api.admin.documents.generateUploadUrl);
  const commit = useMutation(api.admin.batchImports.commit);
  const prepareDuplicateChecks = useMutation(api.admin.batchImports.prepareDuplicateChecks);
  const storageKey = `judgment-batch-v1:${userId}`;
  const [raw, setRaw] = useState("");
  const [batch, setBatch] = useState<SavedBatch | null>(null);
  const current = useRef<SavedBatch | null>(null);
  const [files, setFiles] = useState<Map<string, File>>(new Map());
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const generation = useRef(0);
  const running = useRef(false);
  const cancelled = useRef(false);
  const upload = useRef<AbortController | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [persistenceError, setPersistenceError] = useState(false);
  const jurisdiction = useQueryState({ query: api.admin.resources.listJurisdictions, args: batch ? {
    id: batch.manifest.jurisdictionId as Id<"jurisdictions">, paginationOpts: { numItems: 1, cursor: null },
  } : "skip" });
  const target = jurisdiction.status === "success" ? jurisdiction.data.page[0] : undefined;
  const targetReady = target?._id === batch?.manifest.jurisdictionId && target?.status === "enabled";

  function save(next: SavedBatch | null) {
    current.current = next;
    setBatch(next);
    try {
      if (next) localStorage.setItem(storageKey, JSON.stringify(next));
      else localStorage.removeItem(storageKey);
      setPersistenceError(false);
    } catch { setPersistenceError(true); }
  }

  useEffect(() => {
    generation.current += 1;
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        // Only the manifest is trusted after reload. Server reconciliation re-establishes every result.
        const parsed = JSON.parse(saved) as { manifest: unknown };
        const manifest = parseBatchManifest(JSON.stringify(parsed.manifest));
        const next = { manifest, progress: {} };
        current.current = next; setBatch(next); setRaw(JSON.stringify(manifest, null, 2));
        setMessage("Saved manifest restored. Reselect the PDFs, then resume to reconcile recorded versions.");
      }
    } catch { setError("Saved progress could not be restored. Load your manifest file again."); }
    return () => { generation.current += 1; cancelled.current = true; upload.current?.abort(); };
  }, [storageKey]);

  function update(filename: string, value: Progress) {
    const previous = current.current;
    if (previous) save({ ...previous, progress: { ...previous.progress, [filename]: value } });
  }

  async function run() {
    if (running.current || !current.current || !targetReady) return;
    const runGeneration = generation.current;
    const manifest = current.current.manifest;
    function updateRow(filename: string, value: Progress) {
      if (generation.current === runGeneration) update(filename, value);
    }
    running.current = true; cancelled.current = false; setBusy(true); setError(""); setMessage("");
    try {
      for (const entry of manifest.documents) {
        if (cancelled.current) break;
        const previous = current.current.progress[entry.filename];
        if (finished(previous)) continue;
        const file = files.get(normalizeBatchIdentity(entry.filename));
        if (!file) { updateRow(entry.filename, { ...previous, phase: "Needs PDF", error: "Select the matching PDF to continue." }); continue; }
        let row: Progress = { ...previous, phase: "Checking PDF" };
        updateRow(entry.filename, row);
        try {
          const fingerprint = await fingerprintFile(file, maxBytes);
          row = { ...row, ...fingerprint, storageId: previous?.sha256 === fingerprint.sha256 ? previous.storageId : undefined, error: undefined, result: undefined };
          if (cancelled.current) { updateRow(entry.filename, { ...row, phase: "Stopped" }); break; }
          const args = { jurisdictionId: manifest.jurisdictionId as Id<"jurisdictions">, entry, ...fingerprint };
          const checked: Result = await client.query(api.admin.batchImports.preflight, args);
          if (checked.kind !== "new") {
            updateRow(entry.filename, { ...row, phase: checked.kind === "existing" ? "Already recorded" : "Needs resolution", result: checked });
            continue;
          }
          if (cancelled.current) { updateRow(entry.filename, { ...row, phase: "Stopped" }); break; }
          if (!row.storageId) {
            updateRow(entry.filename, { ...row, phase: "Uploading PDF" });
            const url = await generateUploadUrl({});
            if (cancelled.current) { updateRow(entry.filename, { ...row, phase: "Stopped" }); break; }
            const controller = new AbortController(); upload.current = controller;
            const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/pdf" }, body: file, signal: controller.signal });
            if (!response.ok) throw new Error("Upload failed");
            const payload: unknown = await response.json();
            if (!payload || typeof payload !== "object" || !("storageId" in payload) || typeof payload.storageId !== "string") throw new Error("Invalid upload response");
            row.storageId = payload.storageId;
            updateRow(entry.filename, { ...row, phase: "Uploaded; awaiting record" });
            upload.current = null;
          }
          if (cancelled.current) { updateRow(entry.filename, { ...row, phase: "Stopped" }); break; }
          updateRow(entry.filename, { ...row, phase: "Recording for review" });
          const result: Result = await commit({ ...args, storageId: row.storageId as Id<"_storage"> });
          updateRow(entry.filename, { ...row, phase: result.kind === "conflict" ? "Needs resolution" : "Recorded", result });
        } catch {
          updateRow(entry.filename, { ...row, phase: cancelled.current ? "Stopped" : "Retry needed", error: cancelled.current ? "Stopped. Resume to reconcile any completed transaction." : "This document could not finish. Resume to check the server and safely retry." });
          // Pause on transport/auth failures so a disconnected batch cannot issue the remaining uploads.
          break;
        }
      }
      if (generation.current === runGeneration) setMessage(cancelled.current ? "Uploads stopped. Recorded documents are preserved." : "Batch pass finished. Review each document before approval and publication.");
    } finally { upload.current = null; running.current = false; if (generation.current === runGeneration) setBusy(false); }
  }

  async function prepare() {
    if (running.current || !current.current || !targetReady) return;
    running.current = true; setBusy(true); setPreparing(true); cancelled.current = false;
    const runGeneration = generation.current;
    try {
      let done = false;
      while (!done && !cancelled.current) {
        const result = await prepareDuplicateChecks({ jurisdictionId: current.current.manifest.jurisdictionId as Id<"jurisdictions"> });
        done = result.done;
        if (generation.current !== runGeneration) return;
        setMessage(done ? "Catalog duplicate checks are ready. Select PDFs and upload the pending documents." : "Preparing catalog duplicate checks in bounded batches…");
      }
    } catch { if (generation.current === runGeneration) setError("Catalog duplicate checks could not finish. Prepare again to resume safely."); }
    finally { running.current = false; if (generation.current === runGeneration) { setBusy(false); setPreparing(false); } }
  }

  function loadManifest() {
    if (running.current) return;
    try {
      const manifest = parseBatchManifest(raw);
      save({ manifest, progress: {} }); setFiles(new Map()); setError(""); setMessage("Manifest loaded. Confirm the jurisdiction and metadata, then select the matching PDFs.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Invalid manifest"); }
  }

  function selectFiles(selected: FileList | null) {
    const next = new Map<string, File>();
    for (const file of Array.from(selected ?? [])) {
      const key = normalizeBatchIdentity(file.name);
      if (next.has(key)) { setError("Selected PDFs have overlapping filenames. Select distinct filenames."); setFiles(new Map()); return; }
      next.set(key, file);
    }
    setFiles(next); setError("");
  }

  return <div className="space-y-8">
    <section className="grid gap-5 border-y-2 border-[oklch(35%_0.055_252)] bg-[oklch(96%_0.018_78)] p-5 sm:p-7" aria-label="Batch manifest">
      <div className="grid gap-3 lg:grid-cols-2">
        <div><h2 className="text-2xl font-semibold tracking-tight">Prepare the judgment register</h2><p className="mt-3 text-sm leading-6">Load up to 100 court PDFs with their citations, source links, aliases, and provenance. Each original is recorded for individual review.</p></div>
        <p className="text-sm leading-6">Progress metadata is saved in this browser for your account. Reselect PDFs after returning. An interrupted record is checked on the server before retrying. <a href="https://github.com/theonlyamos/law-of-the-land/blob/development/docs/admin/batch-import.md" target="_blank" rel="noreferrer" className="underline">Manifest format and workflow</a></p>
      </div>
      <label className={labelClass}>Manifest file<input type="file" accept=".json,application/json" disabled={busy} className={fieldClass} onChange={async (event) => {
        const file = event.target.files?.[0]; if (!file) return;
        if (file.size > 1_000_000) { setError("The manifest exceeds the 1 MB text limit."); return; }
        try { setRaw(await file.text()); setError(""); } catch { setError("The manifest file could not be read."); }
      }} /></label>
      <label className={labelClass}>Manifest JSON<textarea rows={8} value={raw} disabled={busy} onChange={(event) => setRaw(event.target.value)} maxLength={1_000_000} className={`${fieldClass} p-3 font-mono text-sm`} /></label>
      <div className="flex flex-wrap gap-3"><button type="button" className={secondaryButtonClass} disabled={busy} onClick={loadManifest}>Load manifest</button><button type="button" className={secondaryButtonClass} disabled={busy || !batch} onClick={() => { save(null); setRaw(""); setFiles(new Map()); setMessage("Saved batch cleared. Server records are preserved."); }}>Clear saved batch</button></div>
    </section>
    {error ? <p role="alert" className="text-sm font-semibold text-red-800">{error}</p> : null}
    {persistenceError ? <p role="alert">Browser storage is unavailable. Keep your manifest and reselect PDFs to reconcile progress after navigation.</p> : null}
    {message ? <p role="status" className="text-sm font-medium">{message}</p> : null}
    {batch ? <>
      <section aria-label="Upload queue" className="space-y-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3"><h2 className="text-2xl font-semibold">{target?.name ?? "Checking jurisdiction…"}</h2><p className="text-sm">{batch.manifest.documents.filter((entry) => finished(batch.progress[entry.filename])).length} / {batch.manifest.documents.length} recorded or matched</p></div>
        <p className="break-all text-xs">Jurisdiction ID: {batch.manifest.jurisdictionId}</p>
        {jurisdiction.status === "error" || (jurisdiction.status === "success" && !targetReady) ? <p role="alert">An enabled jurisdiction could not be confirmed. Check the manifest jurisdiction ID and your access before uploading.</p> : null}
        <label className={labelClass}>Judgment PDFs<input type="file" accept=".pdf,application/pdf" multiple disabled={busy} onChange={(event) => selectFiles(event.target.files)} className={fieldClass} /></label>
        <div className="flex flex-wrap gap-3"><button type="button" className={secondaryButtonClass} disabled={busy || !targetReady} onClick={() => void prepare()}>{preparing ? "Preparing duplicate checks…" : "Prepare duplicate checks"}</button><button type="button" className={buttonClass} disabled={busy || !targetReady || files.size === 0} onClick={() => void run()}>Upload pending PDFs</button><button type="button" className={secondaryButtonClass} disabled={!busy} onClick={() => { cancelled.current = true; upload.current?.abort(); }}>Stop uploads</button></div>
        <p className="text-sm leading-6">Stop pauses the queue and interrupts an active transfer. A database transaction already sent may complete. Use Review document to inspect the original and personally record the existing five review checks, evaluation evidence, reason, and publication confirmation.</p>
      </section>
      <ol className="space-y-6">{batch.manifest.documents.map((entry: BatchImportEntry, index) => {
        const progress = batch.progress[entry.filename];
        const result = progress?.result;
        return <li key={entry.filename} className="border-t-2 border-[oklch(35%_0.055_252)] py-6">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-widest">Judgment {index + 1} / {entry.issuer}</p><h3 className="mt-2 text-xl font-semibold">{entry.title}</h3><p className="mt-2 text-sm">{entry.officialCitation}</p></div><span className="border border-[oklch(48%_0.045_252)] px-3 py-2 text-xs font-semibold" role="status">{progress?.phase ?? (files.has(normalizeBatchIdentity(entry.filename)) ? "PDF selected" : "Needs PDF")}</span></div>
          <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2">
            <div><dt className="font-semibold">Original file</dt><dd className="mt-1 break-all">{entry.filename}</dd></div>
            <div><dt className="font-semibold">Source record</dt><dd className="mt-1"><a href={entry.sourceUrl} target="_blank" rel="noreferrer" className="break-all underline">{entry.sourceUrl}</a></dd></div>
            <div className="sm:col-span-2"><dt className="font-semibold">Provenance and verification evidence</dt><dd className="mt-1 whitespace-pre-wrap break-words">{entry.sourceProvenance}</dd></div>
            <div><dt className="font-semibold">Topics</dt><dd className="mt-1">{entry.topics.join(", ") || "None"}</dd></div><div><dt className="font-semibold">Case aliases</dt><dd className="mt-1 break-words">{entry.caseAliases.join("; ") || "None supplied"}</dd></div>
            {entry.effectiveDate ? <div><dt className="font-semibold">Effective date</dt><dd>{entry.effectiveDate}</dd></div> : null}
            {progress?.sha256 ? <div className="sm:col-span-2"><dt className="font-semibold">SHA-256</dt><dd className="mt-1 break-all font-mono text-xs">{progress.sha256}</dd></div> : null}
          </dl>
          {progress?.error ? <p role="alert" className="mt-4 text-sm font-medium text-red-800">{progress.error}</p> : null}
          {result ? <p className="mt-4 text-sm">{result.message}</p> : null}
          {result?.versionId ? <div className="mt-4 space-y-3 text-sm"><VersionStatus versionId={result.versionId} /><div className="flex flex-wrap gap-5"><Link className="inline-flex min-h-11 items-center font-semibold underline" href={`/admin/review?versionId=${encodeURIComponent(result.versionId)}`}>Review document</Link><Link className="inline-flex min-h-11 items-center underline" href={`/admin/documents/${encodeURIComponent(result.resourceId!)}`}>Open document record</Link></div></div> : null}
        </li>;
      })}</ol>
    </> : <p className="text-sm">A manifest must identify an existing enabled jurisdiction. Copy its ID from the jurisdiction or document register.</p>}
  </div>;
}
