"use client";

import { useEffect, useRef, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export function DocumentFilters({ name, status }: { name: string; status: string }) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pending, startTransition] = useTransition();
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function apply(form: HTMLFormElement) {
    if (timer.current) clearTimeout(timer.current);
    const data = new FormData(form);
    const parameters = new URLSearchParams();
    for (const key of ["name", "status"]) {
      const value = String(data.get(key) ?? "").trim();
      if (value) parameters.set(key, value);
    }
    startTransition(() => router.replace(`/admin/documents${parameters.size ? `?${parameters}` : ""}`, { scroll: false }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    apply(event.currentTarget);
  }

  const fieldClass = "min-h-11 border border-[oklch(61%_0.035_252)] bg-[oklch(98%_0.01_82)] px-3 text-base font-normal normal-case tracking-normal text-[oklch(23%_0.045_252)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700";
  return (
    <form onSubmit={submit} role="search" aria-label="Search documents" aria-busy={pending} className="mb-7 grid items-end gap-4 border-y border-[oklch(74%_0.028_78)] bg-[oklch(91%_0.028_79)] px-4 py-5 @min-[40rem]:grid-cols-[12rem_minmax(16rem,1fr)_auto] sm:px-6">
      <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em]">Catalog state
        <select name="status" defaultValue={status} className={fieldClass} onChange={(event) => apply(event.currentTarget.form!)}>
          <option value="">All states</option><option value="active">Active</option><option value="repealed">Repealed</option><option value="archived">Archived</option>
        </select>
      </label>
      <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em]">Document name
        <input type="search" name="name" defaultValue={name} maxLength={200} placeholder="Search by document name…" className={fieldClass} onChange={(event) => {
          const form = event.currentTarget.form!;
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => apply(form), 350);
        }} />
      </label>
      <button type="submit" className="min-h-11 bg-[oklch(28%_0.055_252)] px-5 text-sm font-semibold text-[oklch(97%_0.012_82)]">Search</button>
      <span role="status" className="sr-only">{pending ? "Searching documents…" : ""}</span>
    </form>
  );
}
