"use client";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { lazy, Suspense, type FormEvent, useEffect, useState } from "react";
import type { GeographicPlaceSelection } from "./geographic-place-picker";

const fieldClass = "min-h-11 w-full border border-[oklch(61%_0.035_252)] bg-[oklch(98%_0.01_82)] px-3 text-base text-[oklch(23%_0.045_252)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700";
const labelClass = "grid gap-2 text-xs font-semibold uppercase tracking-[0.11em] text-[oklch(39%_0.045_252)]";
const buttonClass = "inline-flex min-h-11 items-center justify-center bg-[oklch(28%_0.055_252)] px-4 text-sm font-semibold text-[oklch(97%_0.012_82)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 disabled:opacity-50";
const secondaryButtonClass = "inline-flex min-h-11 items-center justify-center border border-[oklch(48%_0.045_252)] px-4 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 disabled:opacity-50";

const GeographicPlacePicker = lazy(() => import("./geographic-place-picker").then((module) => ({ default: module.GeographicPlacePicker })));

type GeographicLevel = "country" | "state" | "province" | "region" | "district" | "city" | "town" | "territory" | "other_locality";
type OrganizationClass = "intergovernmental" | "government" | "company" | "university" | "nonprofit" | "professional_association" | "other";
type OrganizationOption = { id: string; name: string; slug: string; class: OrganizationClass };
type GeographicOption = { id: string; name: string; level: GeographicLevel; parent: null | { id: string; name: string; level: GeographicLevel } };
type OptionPage = { currentCursor?: string | null; nextCursor: string; isDone: boolean };

export type JurisdictionEditorProps = {
  organizations?: readonly OrganizationOption[];
  organizationPage?: OptionPage;
  geographicOptions?: readonly GeographicOption[];
  geographicPage?: OptionPage;
};

const LEVELS: readonly GeographicLevel[] = ["country", "state", "province", "region", "district", "city", "town", "territory", "other_locality"];
const ORGANIZATION_CLASSES: readonly OrganizationClass[] = ["intergovernmental", "government", "company", "university", "nonprofit", "professional_association", "other"];
const PARENTS: Record<GeographicLevel, readonly GeographicLevel[]> = {
  country: [],
  state: ["country"], province: ["country"], region: ["country"], territory: ["country"],
  district: ["country", "state", "province", "region", "territory"],
  city: ["country", "state", "province", "region", "territory", "district"],
  town: ["country", "state", "province", "region", "territory", "district"],
  other_locality: ["country", "state", "province", "region", "territory", "district"],
};

function optionalBucket(value: string) { const result = value.trim(); return result || undefined; }
function safeReason(value: string) {
  const result = value.trim();
  return result.length >= 3 && result.length <= 500 &&
    !/(?:^|[^A-Za-z0-9+.-])[a-z][a-z0-9+.-]*:(?:\/\/)?\S+/i.test(result) &&
    !/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(result) &&
    !/\b(?:token|auth|password|passwd|cookie|credentials?|signature|authorization|bearer|secret|private\s+key|api\s+key|(?:access|refresh|id|session)\s+token)\b/i.test(result.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " "));
}
function validWebsite(value: string) {
  if (!value) return true;
  if (value.length > 500) return false;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
}

function mergeById<T extends { id: string }>(current: readonly T[], next: readonly T[]) {
  return [...new Map([...current, ...next].map((option) => [option.id, option])).values()];
}

function OrganizationSelect({ initial, page }: { initial: readonly OrganizationOption[]; page?: OptionPage }) {
  const [options, setOptions] = useState(() => [...initial]);
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [cursor, setCursor] = useState(page?.nextCursor ?? "");
  const [done, setDone] = useState(page?.isDone ?? true);
  const [request, setRequest] = useState<null | { query?: string; paginationOpts: { numItems: number; cursor: string | null } }>(null);
  const result = useQuery(api.admin.organizations.listActiveOrganizationOptions, request ?? "skip");
  useEffect(() => {
    if (!result || !request) return;
    setOptions((current) => request.paginationOpts.cursor ? mergeById(current, result.page) : mergeById(current.filter((option) => option.id === selected), result.page));
    setCursor(result.continueCursor); setDone(result.isDone); setRequest(null);
  }, [request, result, selected]);
  function search() {
    const value = query.trim();
    if (value && value.length < 2) return;
    setActiveQuery(value); setRequest({ ...(value ? { query: value } : {}), paginationOpts: { numItems: 20, cursor: null } });
  }
  return <div className="grid min-w-0 gap-2 sm:col-span-2">
    <div className="flex flex-wrap items-end gap-2"><label className={`${labelClass} min-w-[12rem] flex-1`}>Find organization<input aria-label="Find organization" value={query} maxLength={100} onChange={(event) => setQuery(event.target.value)} className={fieldClass} /></label><button type="button" disabled={query.trim().length === 1} onClick={search} className={secondaryButtonClass}>Search organizations</button></div>
    <label className={labelClass}>Organization<select aria-label="Organization" name="organizationId" value={selected} onChange={(event) => setSelected(event.target.value)} required className={fieldClass}><option value="">Select an active organization</option>{options.map((organization) => <option key={organization.id} value={organization.id}>{organization.name} ({organization.class.replaceAll("_", " ")})</option>)}</select></label>
    {!done ? <button type="button" onClick={() => setRequest({ ...(activeQuery ? { query: activeQuery } : {}), paginationOpts: { numItems: 20, cursor } })} className={secondaryButtonClass}>Load more organizations</button> : null}
  </div>;
}

function GeographicParentField({ level, selection, value, onChange, initial }: { level: GeographicLevel; selection: GeographicPlaceSelection | null; value: string; onChange(value: string): void; initial: readonly GeographicOption[] }) {
  const aliases = selection ? [...new Set(selection.place.addressComponents.flatMap((component) => [component.longText.trim(), component.shortText.trim()]).filter(Boolean))].slice(0, 20) : [];
  const suggested = useQuery(api.admin.jurisdictions.suggestGeographicParentsByAliases, selection && aliases.length > 0 ? { childLevel: level, aliases } : "skip");
  const [options, setOptions] = useState(() => initial.filter((option) => PARENTS[level].includes(option.level)));
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [cursor, setCursor] = useState("");
  const [done, setDone] = useState(false);
  const [request, setRequest] = useState<null | { purpose: "parent"; childLevel: GeographicLevel; query?: string; paginationOpts: { numItems: number; cursor: string | null } }>(null);
  const result = useQuery(api.admin.jurisdictions.listGeographicJurisdictionOptions, request ?? "skip");
  useEffect(() => { if (suggested) setOptions((current) => mergeById(current, suggested)); }, [suggested]);
  useEffect(() => {
    if (!result || !request) return;
    setOptions((current) => request.paginationOpts.cursor ? mergeById(current, result.page) : mergeById(current.filter((option) => option.id === value), mergeById(suggested ?? [], result.page)));
    setCursor(result.continueCursor); setDone(result.isDone); setRequest(null);
  }, [request, result, suggested]);
  function search() { const normalized = query.trim(); if (normalized && normalized.length < 2) return; setActiveQuery(normalized); setRequest({ purpose: "parent", childLevel: level, ...(normalized ? { query: normalized } : {}), paginationOpts: { numItems: 20, cursor: null } }); }
  return <div className="grid min-w-0 gap-2 sm:col-span-2">
    <div className="flex flex-wrap items-end gap-2"><label className={`${labelClass} min-w-[12rem] flex-1`}>Find governed parent<input aria-label="Find governed parent" value={query} maxLength={100} onChange={(event) => setQuery(event.target.value)} className={fieldClass} /></label><button type="button" disabled={query.trim().length === 1} onClick={search} className={secondaryButtonClass}>Search parents</button></div>
    <label className={labelClass}>Governed parent<select aria-label="Governed parent" value={value} onChange={(event) => onChange(event.target.value)} disabled={options.length === 0} className={fieldClass}><option value="">Select an eligible parent</option>{options.map((option) => <option key={option.id} value={option.id}>{option.name} ({option.level})</option>)}</select></label>
    {!done ? <button type="button" onClick={() => setRequest({ purpose: "parent", childLevel: level, ...(activeQuery ? { query: activeQuery } : {}), paginationOpts: { numItems: 20, cursor: cursor || null } })} className={secondaryButtonClass}>Load more parents</button> : null}
    {options.length === 0 ? <p className="break-words text-sm">No governed parent is available. <Link href="/admin/jurisdictions?create=parent" className="font-semibold underline underline-offset-4">Create the parent jurisdiction first</Link>.</p> : <p role="status" aria-live="polite" className="text-sm">Choose a parent explicitly; address matches are suggestions only.</p>}
  </div>;
}

function LinkedGeographyField({ initial, page, selected, onChange }: { initial: readonly GeographicOption[]; page?: OptionPage; selected: readonly string[]; onChange(ids: string[]): void }) {
  const [options, setOptions] = useState(() => [...initial]);
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [cursor, setCursor] = useState(page?.nextCursor ?? "");
  const [done, setDone] = useState(page?.isDone ?? true);
  const [request, setRequest] = useState<null | { purpose: "linked_scope"; query?: string; paginationOpts: { numItems: number; cursor: string | null } }>(null);
  const result = useQuery(api.admin.jurisdictions.listGeographicJurisdictionOptions, request ?? "skip");
  useEffect(() => {
    if (!result || !request) return;
    setOptions((current) => request.paginationOpts.cursor ? mergeById(current, result.page) : mergeById(current.filter((option) => selected.includes(option.id)), result.page));
    setCursor(result.continueCursor); setDone(result.isDone); setRequest(null);
  }, [request, result, selected]);
  function search() { const normalized = query.trim(); if (normalized && normalized.length < 2) return; setActiveQuery(normalized); setRequest({ purpose: "linked_scope", ...(normalized ? { query: normalized } : {}), paginationOpts: { numItems: 20, cursor: null } }); }
  return <fieldset className="grid min-w-0 gap-2 sm:col-span-2 lg:col-span-4"><legend className="text-xs font-semibold uppercase tracking-[0.11em] text-[oklch(39%_0.045_252)]">Linked geographies (choose 1-8)</legend>
    <div className="flex flex-wrap items-end gap-2"><label className={`${labelClass} min-w-[12rem] flex-1`}>Find linked geography<input aria-label="Find linked geography" value={query} maxLength={100} onChange={(event) => setQuery(event.target.value)} className={fieldClass} /></label><button type="button" disabled={query.trim().length === 1} onClick={search} className={secondaryButtonClass}>Search geographies</button></div>
    <div className="flex flex-wrap gap-x-5 gap-y-2">{options.map((option) => <label key={option.id} className="flex min-h-11 items-center gap-2 break-words"><input type="checkbox" aria-label={option.name} checked={selected.includes(option.id)} disabled={!selected.includes(option.id) && selected.length >= 8} onChange={(event) => onChange(event.target.checked ? [...new Set([...selected, option.id])] : selected.filter((id) => id !== option.id))} />{option.name}</label>)}</div>
    {!done ? <button type="button" onClick={() => setRequest({ purpose: "linked_scope", ...(activeQuery ? { query: activeQuery } : {}), paginationOpts: { numItems: 20, cursor } })} className={secondaryButtonClass}>Load more geographies</button> : null}
  </fieldset>;
}

export function JurisdictionEditor({ organizations = [], organizationPage, geographicOptions = [], geographicPage }: JurisdictionEditorProps) {
  const router = useRouter();
  const createGeographic = useMutation(api.admin.jurisdictions.createGeographicJurisdiction);
  const createOrganizational = useMutation(api.admin.jurisdictions.createOrganizationalJurisdiction);
  const createOrganization = useMutation(api.admin.organizations.createOrganization);
  const [kind, setKind] = useState<"geographic" | "organizational" | null>(null);
  const [selection, setSelection] = useState<GeographicPlaceSelection | null>(null);
  const [level, setLevel] = useState<GeographicLevel>("country");
  const [parentId, setParentId] = useState("");
  const [organizationMode, setOrganizationMode] = useState<"choose" | "create">("choose");
  const [scopeMode, setScopeMode] = useState<"global" | "linked_geographies">("global");
  const [linkedIds, setLinkedIds] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  function switchKind(next: "geographic" | "organizational") {
    setKind(next); setSelection(null); setParentId(""); setLinkedIds([]); setError(""); setSuccess("");
  }

  function placeChanged(next: GeographicPlaceSelection | null) {
    setSelection(next);
    setParentId("");
    if (!next) setError("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!kind) { setError("Choose a jurisdiction type first."); return; }
    const form = event.currentTarget;
    const data = new FormData(form);
    const reason = text(data, "reason").trim();
    const stagingBucketId = optionalBucket(text(data, "stagingBucketId"));
    const productionText = text(data, "productionBucketId").trim();
    if (!safeReason(reason)) { setError("Use a 3-500 character audit reason without URLs, email addresses, or sensitive terms."); return; }
    if (stagingBucketId && stagingBucketId.length > 300) { setError("Staging bucket ID must be 300 characters or fewer."); return; }
    if (productionText && (!/^[1-9]\d*$/.test(productionText) || !Number.isSafeInteger(Number(productionText)))) { setError("Production bucket ID must be a positive safe integer."); return; }
    const productionBucketId = productionText || undefined;
    setPending(true); setError(""); setSuccess("");
    try {
      if (kind === "geographic") {
        if (!selection || selection.expiresAt <= Date.now()) throw new Error("EXPIRED_PLACE");
        if (level !== "country" && !parentId) throw new Error("PARENT_REQUIRED");
        if (level === "country" && parentId) throw new Error("ROOT_PARENT_FORBIDDEN");
        await createGeographic({
          verifiedPlaceClaim: selection.verifiedPlaceClaim,
          level,
          ...(parentId ? { parentJurisdictionId: parentId as Id<"jurisdictions"> } : {}),
          ...(stagingBucketId ? { stagingBucketId } : {}),
          ...(productionBucketId ? { productionBucketId } : {}),
          reason,
        });
      } else {
        let organizationId = text(data, "organizationId").trim();
        if (organizationMode === "create") {
          const name = text(data, "organizationName").trim();
          const slug = text(data, "organizationSlug").trim();
          const website = text(data, "organizationWebsite").trim();
          if (name.length < 1 || name.length > 300 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80 || !validWebsite(website)) {
            throw new Error("INVALID_ORGANIZATION");
          }
          organizationId = await createOrganization({
            name, slug, class: text(data, "organizationClass") as OrganizationClass,
            ...(website ? { website } : {}), reason,
          });
        }
        if (!organizationId) throw new Error("ORGANIZATION_REQUIRED");
        const distinctIds = [...new Set(linkedIds)];
        if (scopeMode === "linked_geographies" && (distinctIds.length < 1 || distinctIds.length > 8)) throw new Error("LINKED_SCOPE_REQUIRED");
        await createOrganizational({
          organizationId: organizationId as Id<"organizations">,
          visibility: text(data, "visibility") as "public" | "members",
          scopeMode,
          geographicJurisdictionIds: (scopeMode === "global" ? [] : distinctIds) as Id<"jurisdictions">[],
          ...(stagingBucketId ? { stagingBucketId } : {}),
          ...(productionBucketId ? { productionBucketId } : {}),
          reason,
        });
      }
      form.reset(); switchKind(kind); setKind(null); setSuccess("Draft jurisdiction created. Provider synchronization is pending."); router.refresh();
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "";
      setError(code === "PARENT_REQUIRED" ? "Select an eligible governed parent before creating this locality."
        : code === "EXPIRED_PLACE" ? "The verified place expired. Search and select it again."
          : code === "INVALID_ORGANIZATION" ? "Review the organization name, lowercase slug, class, and optional HTTPS website."
            : "The draft jurisdiction was not created. Review the selections and your catalog permissions, then retry.");
    } finally { setPending(false); }
  }

  return (
    <form onSubmit={submit} className="grid gap-5 border-y border-[oklch(73%_0.03_77)] bg-[oklch(94%_0.022_79)] px-4 py-5 sm:grid-cols-2 lg:grid-cols-4">
      <fieldset className="grid gap-3 sm:col-span-2 lg:col-span-4">
        <legend className="text-xs font-semibold uppercase tracking-[0.11em] text-[oklch(39%_0.045_252)]">Jurisdiction type</legend>
        <div className="flex flex-wrap gap-5">
          {(["geographic", "organizational"] as const).map((value) => <label key={value} className="flex min-h-11 items-center gap-2 font-semibold"><input type="radio" name="kind" checked={kind === value} onChange={() => switchKind(value)} className="size-5 accent-amber-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700" />{value === "geographic" ? "Geographic" : "Organizational"}</label>)}
        </div>
      </fieldset>
      {kind === "geographic" ? <>
        <Suspense fallback={<p role="status" aria-live="polite" className="sm:col-span-2 lg:col-span-4">Loading secure place search…</p>}><GeographicPlacePicker value={selection} onChange={placeChanged} disabled={pending} /></Suspense>
        <label className={labelClass}>Geographic level<select aria-label="Geographic level" value={level} onChange={(event) => { setLevel(event.target.value as GeographicLevel); setParentId(""); }} className={fieldClass}>{LEVELS.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select></label>
        {level !== "country" ? <GeographicParentField key={level} level={level} selection={selection} value={parentId} onChange={setParentId} initial={geographicOptions} /> : null}
      </> : null}
      {kind === "organizational" ? <>
        <fieldset className="grid gap-2 sm:col-span-2"><legend className="text-xs font-semibold uppercase tracking-[0.11em] text-[oklch(39%_0.045_252)]">Organization source</legend><div className="flex flex-wrap gap-4">{(["choose", "create"] as const).map((mode) => <label key={mode} className="flex min-h-11 items-center gap-2 font-semibold"><input type="radio" name="organizationMode" checked={organizationMode === mode} onChange={() => setOrganizationMode(mode)} />{mode === "choose" ? "Choose organization" : "Create organization"}</label>)}</div></fieldset>
        {organizationMode === "choose" ? <OrganizationSelect initial={organizations} page={organizationPage} /> : <>
          <label className={labelClass}>Organization name<input aria-label="Organization name" name="organizationName" minLength={1} maxLength={300} required className={fieldClass} /></label>
          <label className={labelClass}>Organization slug<input aria-label="Organization slug" name="organizationSlug" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxLength={80} required className={fieldClass} /></label>
          <label className={labelClass}>Organization class<select name="organizationClass" className={fieldClass}>{ORGANIZATION_CLASSES.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select></label>
          <label className={labelClass}>Organization HTTPS website<input aria-label="Organization HTTPS website" name="organizationWebsite" type="url" maxLength={500} className={fieldClass} /></label>
        </>}
        <label className={labelClass}>Visibility<select aria-label="Visibility" name="visibility" className={fieldClass}><option value="public">Public</option><option value="members">All active members</option></select></label>
        <label className={labelClass}>Scope mode<select aria-label="Scope mode" value={scopeMode} onChange={(event) => { setScopeMode(event.target.value as typeof scopeMode); setLinkedIds([]); }} className={fieldClass}><option value="global">Global</option><option value="linked_geographies">Linked geographies</option></select></label>
        {scopeMode === "linked_geographies" ? <LinkedGeographyField initial={geographicOptions} page={geographicPage} selected={linkedIds} onChange={setLinkedIds} /> : null}
      </> : null}
      <label className={labelClass}>Staging bucket ID<input name="stagingBucketId" maxLength={300} className={fieldClass} /></label>
      <label className={labelClass}>Production bucket ID<input name="productionBucketId" inputMode="numeric" pattern="[1-9][0-9]*" className={fieldClass} /></label>
      <label className={`${labelClass} sm:col-span-2`}>Audit reason<input aria-label="Audit reason" name="reason" required minLength={3} maxLength={500} className={fieldClass} /></label>
      <div className="flex flex-wrap gap-3 sm:col-span-2 lg:col-span-4"><button disabled={pending || !kind} className={buttonClass}>{pending ? "Creating draft…" : "Create draft jurisdiction"}</button></div>
      {success ? <p role="status" aria-live="polite" className="text-sm sm:col-span-2 lg:col-span-4">{success}</p> : null}
      {error ? <p role="alert" className="text-sm text-red-800 sm:col-span-2 lg:col-span-4">{error}</p> : null}
    </form>
  );
}

function text(data: FormData, key: string) { return String(data.get(key) ?? ""); }

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
