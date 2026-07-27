"use client";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { type FormEvent, useState } from "react";

const fieldClass = "min-h-11 w-full border border-[oklch(61%_0.035_252)] bg-[oklch(98%_0.01_82)] px-3 text-base text-[oklch(23%_0.045_252)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700";
const labelClass = "grid gap-2 text-xs font-semibold uppercase tracking-[0.11em] text-[oklch(39%_0.045_252)]";
const buttonClass = "inline-flex min-h-11 items-center justify-center bg-[oklch(28%_0.055_252)] px-4 text-sm font-semibold text-[oklch(97%_0.012_82)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 disabled:opacity-50";
const secondaryButtonClass = "inline-flex min-h-11 items-center justify-center border border-[oklch(48%_0.045_252)] px-4 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 disabled:opacity-50";

type JurisdictionInput = {
  id: string;
  code: string;
  name: string;
  slug: string;
  status: "draft" | "enabled" | "archived";
  isDefault: boolean;
  stagingBucketId?: string;
  productionBucketId?: string;
};

function text(data: FormData, key: string) { return String(data.get(key) ?? ""); }
function optionalText(data: FormData, key: string) { const value = text(data, key).trim(); return value || undefined; }

export function JurisdictionEditor({ jurisdiction }: { jurisdiction?: JurisdictionInput }) {
  const router = useRouter();
  const create = useMutation(api.admin.resources.createJurisdiction);
  const update = useMutation(api.admin.resources.updateJurisdiction);
  const enable = useMutation(api.admin.resources.enableJurisdiction);
  const archive = useMutation(api.admin.resources.archiveJurisdiction);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const action = (event.nativeEvent as SubmitEvent).submitter instanceof HTMLButtonElement
      ? ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement).value
      : "save";
    setPending(true);
    setError("");
    try {
      const reason = text(data, "reason");
      if (!jurisdiction) {
        await create({
          code: text(data, "code"), name: text(data, "name"), slug: text(data, "slug"),
          stagingBucketId: optionalText(data, "stagingBucketId"),
          productionBucketId: optionalText(data, "productionBucketId"),
          isDefault: data.get("isDefault") === "on", reason,
        });
        form.reset();
      } else if (action === "enable") {
        await enable({ id: jurisdiction.id as Id<"jurisdictions">, reason });
      } else if (action === "archive") {
        await archive({ id: jurisdiction.id as Id<"jurisdictions">, reason });
      } else {
        await update({
          id: jurisdiction.id as Id<"jurisdictions">,
          name: text(data, "name"), slug: text(data, "slug"),
          stagingBucketId: optionalText(data, "stagingBucketId"),
          productionBucketId: optionalText(data, "productionBucketId"),
          isDefault: data.get("isDefault") === "on", reason,
        });
      }
      router.refresh();
    } catch {
      setError("The jurisdiction change was not accepted. Review the lifecycle, uniqueness, and reason fields.");
    } finally { setPending(false); }
  }

  return (
    <form onSubmit={submit} className="grid gap-4 border-y border-[oklch(73%_0.03_77)] bg-[oklch(94%_0.022_79)] px-4 py-5 sm:grid-cols-2 lg:grid-cols-4">
      <label className={labelClass}>ISO country code<input aria-label="ISO country code" name="code" defaultValue={jurisdiction?.code} disabled={Boolean(jurisdiction)} maxLength={2} required className={fieldClass} /></label>
      <label className={labelClass}>Display name<input name="name" defaultValue={jurisdiction?.name} required className={fieldClass} /></label>
      <label className={labelClass}>URL slug<input name="slug" defaultValue={jurisdiction?.slug} required className={fieldClass} /></label>
      <label className={labelClass}>Staging bucket ID<input name="stagingBucketId" defaultValue={jurisdiction?.stagingBucketId} className={fieldClass} /></label>
      <label className={labelClass}>Production bucket ID<input name="productionBucketId" defaultValue={jurisdiction?.productionBucketId} className={fieldClass} /></label>
      <label className="flex min-h-11 items-center gap-2 self-end text-sm font-semibold"><input type="checkbox" name="isDefault" defaultChecked={jurisdiction?.isDefault} />Default jurisdiction</label>
      <label className={`${labelClass} sm:col-span-2`}>Audit reason<input aria-label="Audit reason" name="reason" required minLength={3} maxLength={500} className={fieldClass} /></label>
      <div className="flex flex-wrap gap-3 sm:col-span-2 lg:col-span-4">
        <button value="save" disabled={pending} className={buttonClass}>{jurisdiction ? "Save jurisdiction metadata" : "Create draft jurisdiction"}</button>
        {jurisdiction?.status === "draft" ? <button value="enable" disabled={pending} className={secondaryButtonClass}>Enable jurisdiction</button> : null}
        {jurisdiction && jurisdiction.status !== "archived" ? <button value="archive" disabled={pending} className={secondaryButtonClass}>Archive jurisdiction</button> : null}
      </div>
      {error ? <p role="alert" className="text-sm text-red-800 sm:col-span-2 lg:col-span-4">{error}</p> : null}
    </form>
  );
}

type ResourceInput = {
  id: string;
  jurisdictionId: string;
  type: "constitution" | "act" | "regulation" | "ordinance" | "judgment" | "policy" | "guidance";
  title: string;
  issuer: string;
  officialCitation: string;
  sourceUrl: string;
  topics: string[];
  effectiveDate: string;
  repealDate?: string;
  status: "active" | "repealed" | "archived";
};

export function ResourceEditor({
  jurisdictionIds,
  jurisdictionOptions,
  jurisdictionPicker,
  resource,
}: {
  jurisdictionIds: readonly string[];
  jurisdictionOptions?: readonly { id: string; code: string; name: string }[];
  jurisdictionPicker?: { searchCode: string; currentCursor?: string | null; nextCursor: string; isDone: boolean };
  resource?: ResourceInput;
}) {
  const router = useRouter();
  const create = useMutation(api.admin.resources.createResource);
  const update = useMutation(api.admin.resources.updateResource);
  const repeal = useMutation(api.admin.resources.markResourceRepealed);
  const archive = useMutation(api.admin.resources.archiveResource);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const action = (event.nativeEvent as SubmitEvent).submitter instanceof HTMLButtonElement
      ? ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement).value
      : "save";
    setPending(true); setError("");
    try {
      const reason = text(data, "reason");
      if (resource && action === "repeal") {
        await repeal({ id: resource.id as Id<"legalResources">, repealDate: text(data, "repealDate"), reason });
      } else if (resource && action === "archive") {
        await archive({ id: resource.id as Id<"legalResources">, reason });
      } else {
        const values = {
          title: text(data, "title"), issuer: text(data, "issuer"), officialCitation: text(data, "officialCitation"),
          sourceUrl: text(data, "sourceUrl"), topics: text(data, "topics").split(",").map((value) => value.trim()).filter(Boolean),
          effectiveDate: text(data, "effectiveDate"), reason,
        };
        if (resource) await update({ id: resource.id as Id<"legalResources">, ...values });
        else await create({ jurisdictionId: text(data, "jurisdictionId") as Id<"jurisdictions">, type: text(data, "type"), ...values });
      }
      if (!resource) form.reset();
      router.refresh();
    } catch { setError("The resource change was not accepted. Review its citation, dates, source URL, and lifecycle state."); }
    finally { setPending(false); }
  }

  const options = jurisdictionOptions ?? jurisdictionIds.map((id) => ({ id, code: id, name: id }));
  const nextParameters = new URLSearchParams();
  if (jurisdictionPicker?.searchCode) nextParameters.set("jurisdictionCode", jurisdictionPicker.searchCode);
  if (jurisdictionPicker?.nextCursor) nextParameters.set("jurisdictionCursor", jurisdictionPicker.nextCursor);

  return (
    <div className="grid gap-4">
      {!resource && jurisdictionPicker ? (
        <div className="flex flex-wrap items-end gap-3 border-t border-[oklch(73%_0.03_77)] pt-4">
          <form action="/admin/documents" method="get" className="flex flex-wrap items-end gap-3">
            <label className={labelClass}>Find jurisdiction by ISO code<input aria-label="Find jurisdiction by ISO code" name="jurisdictionCode" defaultValue={jurisdictionPicker.searchCode} maxLength={2} className={fieldClass} /></label>
            <button className={secondaryButtonClass}>Find jurisdiction</button>
          </form>
          {!jurisdictionPicker.isDone ? <Link className={secondaryButtonClass} href={`/admin/documents?${nextParameters.toString()}`}>Next jurisdictions</Link> : null}
          {jurisdictionPicker.currentCursor ? <Link className={secondaryButtonClass} href="/admin/documents">First jurisdiction page</Link> : null}
          {jurisdictionPicker.searchCode ? <Link className={secondaryButtonClass} href="/admin/documents">Clear jurisdiction search</Link> : null}
        </div>
      ) : null}
      <form onSubmit={submit} className="grid gap-4 border-y border-[oklch(73%_0.03_77)] bg-[oklch(94%_0.022_79)] px-4 py-5 sm:grid-cols-2 lg:grid-cols-4">
      {!resource ? <label className={labelClass}>Jurisdiction ID<select name="jurisdictionId" required disabled={options.length === 0} className={fieldClass}>{options.length === 0 ? <option>No jurisdiction on this page</option> : options.map((option) => <option key={option.id} value={option.id}>{option.code} / {option.name}</option>)}</select></label> : null}
      {!resource ? <label className={labelClass}>Resource type<select name="type" required className={fieldClass}>{["constitution", "act", "regulation", "ordinance", "judgment", "policy", "guidance"].map((type) => <option key={type}>{type}</option>)}</select></label> : null}
      <label className={labelClass}>Title<input name="title" defaultValue={resource?.title} required className={fieldClass} /></label>
      <label className={labelClass}>Issuer<input name="issuer" defaultValue={resource?.issuer} required className={fieldClass} /></label>
      <label className={labelClass}>Official citation<input aria-label="Official citation" name="officialCitation" defaultValue={resource?.officialCitation} required className={fieldClass} /></label>
      <label className={labelClass}>Official HTTPS source<input type="url" name="sourceUrl" defaultValue={resource?.sourceUrl} required className={fieldClass} /></label>
      <label className={labelClass}>Topics, comma separated<input name="topics" defaultValue={resource?.topics.join(", ")} className={fieldClass} /></label>
      <label className={labelClass}>Effective date<input type="date" name="effectiveDate" defaultValue={resource?.effectiveDate} required className={fieldClass} /></label>
      {resource?.status === "active" ? <label className={labelClass}>Repeal transition date<input type="date" name="repealDate" className={fieldClass} /></label> : null}
      <label className={`${labelClass} sm:col-span-2`}>Audit reason<input name="reason" required minLength={3} maxLength={500} className={fieldClass} /></label>
      <div className="flex flex-wrap gap-3 sm:col-span-2 lg:col-span-4">
        <button value="save" disabled={pending || (!resource && options.length === 0)} className={buttonClass}>{resource ? "Save resource metadata" : "Create legal resource"}</button>
        {resource?.status === "active" ? <button value="repeal" disabled={pending} className={secondaryButtonClass}>Mark resource repealed</button> : null}
        {resource && resource.status !== "archived" ? <button value="archive" disabled={pending} className={secondaryButtonClass}>Archive legal resource</button> : null}
      </div>
      {error ? <p role="alert" className="text-sm text-red-800 sm:col-span-2 lg:col-span-4">{error}</p> : null}
      </form>
    </div>
  );
}
