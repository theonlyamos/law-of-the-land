import { api } from "../../../../convex/_generated/api";
import { hasRolePermission } from "../../../../convex/lib/adminPermissions";
import { JurisdictionEditor } from "@/components/admin/catalog-actions";
import { DataTable, readAdminTableNavigation, type AdminTableSearchParams } from "@/components/admin/data-table";
import { CatalogStatus } from "@/components/admin/resource-register";
import { authorizeAdminPage } from "@/lib/admin/server";
import { fetchAuthQuery } from "@/lib/auth-server";
import { redirect } from "next/navigation";

const COLUMNS = [
  { key: "identity", label: "Jurisdiction" },
  { key: "access", label: "Access" },
  { key: "context", label: "Governed context" },
  { key: "provider", label: "Provider state" },
] as const;
const STATUSES = ["draft", "enabled", "archived"] as const;
const KINDS = ["geographic", "organizational"] as const;

type Status = (typeof STATUSES)[number];
type Kind = (typeof KINDS)[number];
type TableRow = {
  id: string; name: string; slug: string; status: Status; kind: Kind; visibility: "public" | "members";
  provider: { syncState: "pending" | "synced" | "drifted" | "failed"; stagingConfigured: boolean; productionConfigured: boolean };
  migrationState: "typed" | "legacy";
  geographic: null | { level: string; parent: null | { id: string; name: string; level: string } };
  organization: null | { id: string; name: string; slug: string; class: string; status: string };
  scopeMode: null | "global" | "linked_geographies";
};
type OptionPage<T> = { page: T[]; continueCursor: string; isDone: boolean };
type OrganizationOption = { id: string; name: string; slug: string; class: "intergovernmental" | "government" | "company" | "university" | "nonprofit" | "professional_association" | "other" };
type GeographicLevel = "country" | "state" | "province" | "region" | "district" | "city" | "town" | "territory" | "other_locality";
type GeographicOption = { id: string; name: string; level: GeographicLevel; parent: null | { id: string; name: string; level: GeographicLevel } };

function single(value: string | string[] | undefined) { return typeof value === "string" ? value : ""; }
function title(value: string) { return value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()); }

export default async function JurisdictionsPage({ searchParams }: { searchParams: Promise<AdminTableSearchParams> }) {
  const parameters = await searchParams;
  const navigation = readAdminTableNavigation(parameters);
  const statusValue = single(parameters.status);
  const kindValue = single(parameters.kind);
  const rawQuery = single(parameters.query);
  const query = rawQuery.trim();
  const validStatus = statusValue === "" || STATUSES.includes(statusValue as Status);
  const validKind = kindValue === "" || KINDS.includes(kindValue as Kind);
  const validQuery = query === "" || (query.length >= 2 && query.length <= 100);

  const access = await authorizeAdminPage();
  if (access.status === "denied" || (!hasRolePermission(access.currentAdmin.roles, "jurisdiction", "read") && !hasRolePermission(access.currentAdmin.roles, "jurisdiction", "write"))) {
    redirect("/admin/forbidden");
  }
  const canWrite = hasRolePermission(access.currentAdmin.roles, "jurisdiction", "write");

  let table: OptionPage<TableRow> | null = null;
  let organizations: OptionPage<OrganizationOption> | null = null;
  let geographies: OptionPage<GeographicOption> | null = null;
  let editorFailed = false;
  let failed = !navigation.isValid || !validStatus || !validKind || !validQuery;
  if (!failed) {
    try {
      const tablePromise = fetchAuthQuery(api.admin.jurisdictions.listAdminJurisdictions, {
        paginationOpts: { numItems: 20, cursor: navigation.cursor },
        ...(statusValue ? { status: statusValue as Status } : {}),
        ...(kindValue ? { kind: kindValue as Kind } : {}),
        ...(query ? { query } : {}),
      }) as Promise<OptionPage<TableRow>>;
      if (canWrite) {
        const [tableResult, organizationResult, geographyResult] = await Promise.allSettled([
          tablePromise,
          fetchAuthQuery(api.admin.organizations.listActiveOrganizationOptions, { paginationOpts: { numItems: 20, cursor: null } }) as Promise<OptionPage<OrganizationOption>>,
          fetchAuthQuery(api.admin.jurisdictions.listGeographicJurisdictionOptions, { purpose: "linked_scope", paginationOpts: { numItems: 20, cursor: null } }) as Promise<OptionPage<GeographicOption>>,
        ]);
        if (tableResult.status === "rejected") throw tableResult.reason;
        table = tableResult.value;
        if (organizationResult.status === "fulfilled" && geographyResult.status === "fulfilled") {
          organizations = organizationResult.value;
          geographies = geographyResult.value;
        } else editorFailed = true;
      } else table = await tablePromise;
    } catch { failed = true; }
  }
  const rows = table?.page ?? [];

  return <div className="mx-auto max-w-[88rem]">
    <header className="grid gap-5 border-b-2 border-[oklch(35%_0.055_252)] pb-7 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.42fr)] lg:items-end">
      <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-[oklch(43%_0.065_67)]">Unified geographic and organizational register</p><h1 className="mt-3 text-[clamp(2.25rem,6vw,4.75rem)] font-semibold leading-[0.96] tracking-[-0.05em] text-[oklch(23%_0.05_252)]">Jurisdictions</h1></div>
      <p className="max-w-[48ch] text-sm leading-6 text-[oklch(41%_0.035_252)]">Draft first, verify relationships, then enable. This register exposes operational readiness without revealing provider identifiers.</p>
    </header>
    {canWrite && organizations && geographies ? <section className="mt-8" aria-labelledby="new-jurisdiction-heading"><h2 id="new-jurisdiction-heading" className="mb-4 text-xl font-semibold tracking-[-0.025em]">Create governed jurisdiction</h2><JurisdictionEditor organizations={organizations.page} organizationPage={{ nextCursor: organizations.continueCursor, isDone: organizations.isDone }} geographicOptions={geographies.page} geographicPage={{ nextCursor: geographies.continueCursor, isDone: geographies.isDone }} /></section> : null}
    {editorFailed ? <p role="alert" className="mt-8 border-y border-red-300 bg-red-50 px-4 py-4 text-sm text-red-900">Creation options could not be loaded. The safe register remains available; refresh before creating a jurisdiction.</p> : null}
    <div className="mt-8"><DataTable
      ariaLabel="Jurisdictions" basePath="/admin/jurisdictions" columns={COLUMNS}
      rows={rows.map((row) => ({ id: row.id, cells: {
        identity: <span className="grid gap-1"><strong>{row.name}</strong><span className="text-xs uppercase tracking-[0.12em]">{title(row.kind)} / {row.migrationState === "legacy" ? "Legacy migration" : `Typed / ${row.slug}`}</span></span>,
        access: <span className="grid gap-1"><CatalogStatus status={row.status} /><span className="text-xs">{row.visibility === "members" ? "Active members" : "Public"}</span></span>,
        context: row.geographic ? <span className="grid gap-1"><strong>{title(row.geographic.level)}</strong><span className="text-xs">{row.geographic.parent ? `Within ${row.geographic.parent.name} (${title(row.geographic.parent.level)})` : "Root geography"}</span></span> : row.organization ? <span className="grid gap-1"><strong>{row.organization.name}</strong><span className="text-xs">{title(row.organization.class)} / {title(row.organization.status)} / {title(row.scopeMode ?? "global")}</span></span> : <span>Awaiting typed migration</span>,
        provider: <span className="grid gap-1 text-xs"><strong>{title(row.provider.syncState)}</strong><span>Staging: {row.provider.stagingConfigured ? "Configured" : "Not configured"}</span><span>Production: {row.provider.productionConfigured ? "Configured" : "Not configured"}</span></span>,
      } }))}
      filters={[
        { name: "status", label: "Lifecycle state", value: statusValue, options: [{ value: "", label: "All states" }, ...STATUSES.map((value) => ({ value, label: title(value) }))] },
        { name: "kind", label: "Jurisdiction type", value: kindValue, options: [{ value: "", label: "All types" }, ...KINDS.map((value) => ({ value, label: title(value) }))] },
        { name: "query", label: "Name search", value: rawQuery, placeholder: "At least 2 characters" },
      ]}
      currentCursor={navigation.cursor} previousCursors={navigation.previousCursors} nextCursor={table?.continueCursor ?? ""} isDone={table?.isDone ?? true}
      state={failed ? "error" : "ready"} emptyMessage="No governed jurisdictions match this view." errorMessage="Jurisdictions could not be loaded. Check the filters and pagination link."
    /></div>
  </div>;
}
