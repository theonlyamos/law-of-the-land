import { api } from "../../../../convex/_generated/api";
import type { Doc } from "../../../../convex/_generated/dataModel";
import { hasRolePermission } from "../../../../convex/lib/adminPermissions";
import { DataTable, readAdminTableNavigation, type AdminTableSearchParams } from "@/components/admin/data-table";
import { CatalogStatus } from "@/components/admin/resource-register";
import { ResourceEditor } from "@/components/admin/catalog-actions";
import { DocumentFilters } from "@/components/admin/document-filters";
import { authorizeAdminPage } from "@/lib/admin/server";
import { fetchAuthQuery } from "@/lib/auth-server";
import Link from "next/link";
import { redirect } from "next/navigation";

const COLUMNS = [
  { key: "instrument", label: "Legal instrument" },
  { key: "jurisdiction", label: "Jurisdiction" },
  { key: "authority", label: "Authority" },
  { key: "state", label: "Catalog state" },
  { key: "effective", label: "Effective" },
] as const;
const STATUSES = ["active", "repealed", "archived"] as const;
function single(value: string | string[] | undefined) { return typeof value === "string" ? value : ""; }

export default async function DocumentsPage({ searchParams }: { searchParams: Promise<AdminTableSearchParams> }) {
  const parameters = await searchParams;
  const navigation = readAdminTableNavigation(parameters);
  const status = single(parameters.status);
  const name = single(parameters.name).trim();
  const jurisdictionCode = single(parameters.jurisdictionCode);
  const jurisdictionCursor = single(parameters.jurisdictionCursor) || null;
  const validStatus = status === "" || STATUSES.includes(status as (typeof STATUSES)[number]);
  const access = await authorizeAdminPage();
  if (
    access.status === "denied" ||
    (!hasRolePermission(access.currentAdmin.roles, "resource", "read") &&
      !hasRolePermission(access.currentAdmin.roles, "resource", "write"))
  ) redirect("/admin/forbidden");
  const canWrite = hasRolePermission(access.currentAdmin.roles, "resource", "write");

  let result: Awaited<ReturnType<typeof fetchAuthQuery>> | null = null;
  let failed = !navigation.isValid || !validStatus;
  if (!failed) {
    try {
      result = await fetchAuthQuery(api.admin.resources.listResources, {
        paginationOpts: { numItems: 30, cursor: navigation.cursor },
        ...(name ? { name } : {}),
        ...(status ? { status: status as (typeof STATUSES)[number] } : {}),
      });
    } catch { failed = true; }
  }
  const rows = (result && "page" in result ? result.page : []) as (Doc<"legalResources"> & { jurisdictionName: string; hasPublishedVersion: boolean })[];
  let jurisdictionOptions: Array<{ id: string; code: string; name: string }> = [];
  let jurisdictionNextCursor = "";
  let jurisdictionIsDone = true;
  if (canWrite && !failed) {
    try {
      const jurisdictions = await fetchAuthQuery(api.admin.resources.listJurisdictions, {
        paginationOpts: { numItems: 25, cursor: jurisdictionCursor },
        ...(jurisdictionCode ? { code: jurisdictionCode } : {}),
      });
      jurisdictionOptions = jurisdictions.page
        .filter((jurisdiction) => jurisdiction.status !== "archived")
        .map((jurisdiction) => ({ id: jurisdiction._id, code: jurisdiction.code, name: jurisdiction.name }));
      jurisdictionNextCursor = jurisdictions.continueCursor;
      jurisdictionIsDone = jurisdictions.isDone;
    } catch { failed = true; }
  }

  return (
    <div className="mx-auto max-w-[88rem]">
      <header className="grid gap-5 border-b-2 border-[oklch(35%_0.055_252)] pb-7 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.42fr)] lg:items-end">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[oklch(43%_0.065_67)]">Legal library / canonical register</p>
          <h1 className="mt-3 text-[clamp(2.25rem,6vw,4.75rem)] font-semibold leading-[0.96] tracking-[-0.05em] text-[oklch(23%_0.05_252)]">Documents</h1>
        </div>
        <p className="max-w-[48ch] text-sm leading-6 text-[oklch(41%_0.035_252)]">Canonical instruments are governed independently from their immutable file versions and review history.</p>
      </header>
      {canWrite ? (
        <section className="mt-8" aria-labelledby="new-resource-heading">
          <h2 id="new-resource-heading" className="mb-4 text-xl font-semibold tracking-[-0.025em]">Create canonical legal resource</h2>
          <ResourceEditor
            jurisdictionIds={jurisdictionOptions.map((row) => row.id)}
            jurisdictionOptions={jurisdictionOptions}
            jurisdictionPicker={{ searchCode: jurisdictionCode, currentCursor: jurisdictionCursor, nextCursor: jurisdictionNextCursor, isDone: jurisdictionIsDone }}
          />
        </section>
      ) : null}
      <div className="mt-8">
        <DataTable
          ariaLabel="Legal resources"
          basePath="/admin/documents"
          filterHeader={<DocumentFilters name={name} status={status} />}
          columns={COLUMNS}
          rows={rows.map((row) => ({ id: row._id, cells: {
            instrument: <span className="grid gap-1"><Link href={`/admin/documents/${row._id}`} className="inline-flex min-h-11 items-center font-semibold underline decoration-2 decoration-amber-700 underline-offset-4">{row.title}</Link><span className="text-xs">{row.type} / {row.officialCitation}</span></span>,
            jurisdiction: row.jurisdictionName,
            authority: <span className="grid gap-1"><span>{row.issuer}</span><a className="break-all text-xs underline underline-offset-4" href={row.sourceUrl} rel="noreferrer" target="_blank">Official source</a></span>,
            state: <CatalogStatus status={row.status === "active" && !row.hasPublishedVersion ? "unpublished" : row.status} />,
            effective: <span>{row.effectiveDate}{row.repealDate ? ` - ${row.repealDate}` : ""}</span>,
          }}))}
          filters={[{ name: "name", label: "Document name", value: name }, { name: "status", label: "Catalog state", value: status, options: [{ value: "", label: "All states" }, ...STATUSES.map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }))] }]}
          currentCursor={navigation.cursor}
          previousCursors={navigation.previousCursors}
          nextCursor={result && "continueCursor" in result ? result.continueCursor : ""}
          isDone={result && "isDone" in result ? result.isDone : true}
          state={failed ? "error" : "ready"}
          emptyMessage="No documents match this name and catalog state."
          errorMessage="Legal resources could not be loaded. Check the filter and pagination link."
        />
      </div>
    </div>
  );
}
