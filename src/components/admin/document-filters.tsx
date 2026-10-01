"use client";

import { useEffect, useRef, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export function DocumentFilters({ name, status, jurisdictionId, jurisdictions, jurisdictionSearch = "", jurisdictionCursor = null, jurisdictionNextCursor = "" }: {
  name: string; status: string; jurisdictionId: string;
  jurisdictions: readonly { id: string; name: string }[];
  jurisdictionSearch?: string; jurisdictionCursor?: string | null; jurisdictionNextCursor?: string;
}) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const statusSelect = useRef<HTMLSelectElement>(null);
  const jurisdictionSelect = useRef<HTMLSelectElement>(null);
  const jurisdictionSearchInput = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    if (nameInput.current) nameInput.current.value = name;
    if (statusSelect.current) statusSelect.current.value = status;
    if (jurisdictionSelect.current) jurisdictionSelect.current.value = jurisdictionId;
    if (jurisdictionSearchInput.current) jurisdictionSearchInput.current.value = jurisdictionSearch;
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [name, status, jurisdictionId, jurisdictionSearch, jurisdictionCursor]);

  function apply(form: HTMLFormElement, browse?: { cursor: string | null }) {
    if (timer.current) clearTimeout(timer.current);
    const data = new FormData(form);
    const parameters = new URLSearchParams();
    for (const key of ["name", "status", "jurisdictionId"]) {
      const value = String(data.get(key) ?? "").trim();
      if (value) parameters.set(key, value);
    }
    const search = browse ? String(data.get("filterJurisdictionName") ?? "").trim() : jurisdictionSearch;
    const cursor = browse ? (search === jurisdictionSearch ? browse.cursor : null) : jurisdictionCursor;
    if (search) parameters.set("filterJurisdictionName", search);
    if (cursor) parameters.set("filterJurisdictionCursor", cursor);
    startTransition(() => router.replace(`/admin/documents${parameters.size ? `?${parameters}` : ""}`, { scroll: false }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    apply(event.currentTarget);
  }

  const fieldClass = "min-h-11 border border-[oklch(61%_0.035_252)] bg-[oklch(98%_0.01_82)] px-3 text-base font-normal normal-case tracking-normal text-[oklch(23%_0.045_252)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700";
  return (
    <form onSubmit={submit} role="search" aria-label="Search documents" aria-busy={pending} className="mb-7 grid items-start gap-4 border-y border-[oklch(74%_0.028_78)] bg-[oklch(91%_0.028_79)] px-4 py-5 @min-[40rem]:grid-cols-2 @min-[64rem]:grid-cols-[12rem_minmax(12rem,0.7fr)_minmax(16rem,1fr)_auto] sm:px-6">
      <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em]">Catalog state
        <select ref={statusSelect} name="status" defaultValue={status} className={fieldClass} onChange={(event) => apply(event.currentTarget.form!)}>
          <option value="">All states</option><option value="active">Active</option><option value="unpublished">Unpublished</option><option value="repealed">Repealed</option><option value="archived">Archived</option>
        </select>
      </label>
      <div className="grid min-w-0 gap-2">
      <label className="grid min-w-0 gap-2 text-xs font-semibold uppercase tracking-[0.12em]">Jurisdiction
        <select ref={jurisdictionSelect} name="jurisdictionId" defaultValue={jurisdictionId} className={`${fieldClass} min-w-0 w-full`} onChange={(event) => apply(event.currentTarget.form!)}>
          <option value="">All jurisdictions</option>
          {jurisdictions.map((jurisdiction) => <option key={jurisdiction.id} value={jurisdiction.id}>{jurisdiction.name}</option>)}
        </select>
      </label>
        <details open={Boolean(jurisdictionSearch || jurisdictionCursor)} className="text-sm">
        <summary className="min-h-11 cursor-pointer py-3 underline underline-offset-4">Find more jurisdictions</summary>
        <div className="grid gap-2">
        <label className="sr-only" htmlFor="filter-jurisdiction-name">Find jurisdiction by name</label>
        <input ref={jurisdictionSearchInput} id="filter-jurisdiction-name" name="filterJurisdictionName" defaultValue={jurisdictionSearch} maxLength={200} placeholder="Find jurisdiction by name…" className={`${fieldClass} min-w-0 w-full`} onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); apply(event.currentTarget.form!, { cursor: null }); }
        }} />
        <div className="flex flex-wrap gap-3 text-sm">
          <button type="button" className="min-h-11 underline underline-offset-4" onClick={(event) => apply(event.currentTarget.form!, { cursor: null })}>Find jurisdiction</button>
          {jurisdictionNextCursor ? <button type="button" className="min-h-11 underline underline-offset-4" onClick={(event) => apply(event.currentTarget.form!, { cursor: jurisdictionNextCursor })}>Next jurisdictions</button> : null}
          {jurisdictionCursor ? <button type="button" className="min-h-11 underline underline-offset-4" onClick={(event) => apply(event.currentTarget.form!, { cursor: null })}>First jurisdictions</button> : null}
        </div>
        </div>
        </details>
      </div>
      <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em]">Document name
        <input ref={nameInput} type="search" name="name" defaultValue={name} maxLength={200} placeholder="Search by document name…" className={fieldClass} onChange={(event) => {
          const form = event.currentTarget.form!;
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => apply(form), 350);
        }} />
      </label>
      <button type="submit" className="min-h-11 bg-[oklch(28%_0.055_252)] px-5 text-sm font-semibold text-[oklch(97%_0.012_82)] @min-[64rem]:mt-6">Search</button>
      <span role="status" className="sr-only">{pending ? "Searching documents…" : ""}</span>
    </form>
  );
}
