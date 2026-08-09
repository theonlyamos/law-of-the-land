import { api } from "../../../../convex/_generated/api";
import type { Doc } from "../../../../convex/_generated/dataModel";
import { hasRolePermission } from "../../../../convex/lib/adminPermissions";
import { DataTable, readAdminTableNavigation, type AdminTableSearchParams } from "@/components/admin/data-table";
import { CatalogStatus } from "@/components/admin/resource-register";
import { JurisdictionEditor } from "@/components/admin/catalog-actions";
import { authorizeAdminPage } from "@/lib/admin/server";
import { fetchAuthQuery } from "@/lib/auth-server";
import { redirect } from "next/navigation";

const COLUMNS = [
  { key: "jurisdiction", label: "Jurisdiction" },
  { key: "state", label: "Public state" },
  { key: "buckets", label: "GroundX separation" },
  { key: "sync", label: "Provider sync" },
] as const;

const STATUSES = ["draft", "enabled", "archived"] as const;

function single(value: string | string[] | undefined) {
  return typeof value === "string" ? value : "";
}

function isLegacyJurisdiction(
  row: Doc<"jurisdictions">,
): row is Doc<"jurisdictions"> & { code: string } {
  return typeof row.code === "string" && /^[A-Z]{2}$/.test(row.code);
}

export default async function JurisdictionsPage({ searchParams }: { searchParams: Promise<AdminTableSearchParams> }) {
  const parameters = await searchParams;
  const navigation = readAdminTableNavigation(parameters);
  const status = single(parameters.status);
  const validStatus = status === "" || STATUSES.includes(status as (typeof STATUSES)[number]);
  const access = await authorizeAdminPage();
  if (
    access.status === "denied" ||
    (!hasRolePermission(access.currentAdmin.roles, "jurisdiction", "read") &&
      !hasRolePermission(access.currentAdmin.roles, "jurisdiction", "write"))
  ) redirect("/admin/forbidden");
  const canWrite = hasRolePermission(access.currentAdmin.roles, "jurisdiction", "write");

  let result: Awaited<ReturnType<typeof fetchAuthQuery>> | null = null;
  let failed = !navigation.isValid || !validStatus;
  if (!failed) {
    try {
      result = await fetchAuthQuery(api.admin.resources.listJurisdictions, {
        paginationOpts: { numItems: 30, cursor: navigation.cursor },
        ...(status ? { status: status as (typeof STATUSES)[number] } : {}),
      });
    } catch {
      failed = true;
    }
  }
  const rawRows = (result && "page" in result ? result.page : []) as Doc<"jurisdictions">[];
  // Defense in depth for the server-side legacy projection until the ID-first
  // administration surface replaces this country-code editor.
  const rows = rawRows.filter(isLegacyJurisdiction);

  return (
    <div className="mx-auto max-w-[88rem]">
      <header className="grid gap-5 border-b-2 border-[oklch(35%_0.055_252)] pb-7 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.42fr)] lg:items-end">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[oklch(43%_0.065_67)]">Legal geography / production register</p>
          <h1 className="mt-3 text-[clamp(2.25rem,6vw,4.75rem)] font-semibold leading-[0.96] tracking-[-0.05em] text-[oklch(23%_0.05_252)]">Jurisdictions</h1>
        </div>
        <p className="max-w-[48ch] text-sm leading-6 text-[oklch(41%_0.035_252)]">
          Public search sees only enabled rows with a production bucket. Staging and production identifiers remain visibly separate here.
        </p>
      </header>
      {canWrite ? (
        <section className="mt-8" aria-labelledby="new-jurisdiction-heading">
          <h2 id="new-jurisdiction-heading" className="mb-4 text-xl font-semibold tracking-[-0.025em]">Create governed jurisdiction</h2>
          <JurisdictionEditor />
        </section>
      ) : null}
      <div className="mt-8">
        <DataTable
          ariaLabel="Jurisdictions"
          basePath="/admin/jurisdictions"
          columns={COLUMNS}
          rows={rows.map((row) => ({
            id: row._id,
            cells: {
              jurisdiction: <span className="grid gap-1"><strong>{row.name}</strong><span className="text-xs uppercase tracking-[0.12em]">{row.code} / {row.slug}</span></span>,
              state: <CatalogStatus status={row.status} />,
              buckets: <span className="grid gap-1 text-xs"><span>Staging: {row.stagingBucketId ?? "Not configured"}</span><span>Production: {row.productionBucketId ?? "Not configured"}</span></span>,
              sync: row.providerSyncState.replaceAll("_", " "),
            },
          }))}
          filters={[{ name: "status", label: "Lifecycle state", value: status, options: [{ value: "", label: "All states" }, ...STATUSES.map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }))] }]}
          currentCursor={navigation.cursor}
          previousCursors={navigation.previousCursors}
          nextCursor={result && "continueCursor" in result ? result.continueCursor : ""}
          isDone={result && "isDone" in result ? result.isDone : true}
          state={failed ? "error" : "ready"}
          emptyMessage="No governed jurisdictions match this state."
          errorMessage="Jurisdiction records could not be loaded. Check the filter and pagination link."
        />
      </div>
      {canWrite && rows.length > 0 ? (
        <section className="mt-10" aria-labelledby="jurisdiction-actions-heading">
          <h2 id="jurisdiction-actions-heading" className="text-2xl font-semibold tracking-[-0.03em]">Lifecycle and metadata actions</h2>
          <div className="mt-5 grid gap-5">
            {rows.map((row) => (
              <details key={row._id} className="border-t border-[oklch(70%_0.03_77)] pt-3">
                <summary className="min-h-11 cursor-pointer py-3 font-semibold">{row.code} / {row.name}</summary>
                <JurisdictionEditor jurisdiction={{ id: row._id, code: row.code, name: row.name, slug: row.slug, status: row.status, isDefault: row.isDefault, stagingBucketId: row.stagingBucketId, productionBucketId: row.productionBucketId }} />
              </details>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
