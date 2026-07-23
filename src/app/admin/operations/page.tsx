import { api } from "../../../../convex/_generated/api";
import { hasRolePermission } from "../../../../convex/lib/adminPermissions";
import {
  DataTable,
  readAdminTableNavigation,
  type AdminTableSearchParams,
} from "@/components/admin/data-table";
import { authorizeAdminPage } from "@/lib/admin/server";
import { fetchAuthQuery } from "@/lib/auth-server";
import { redirect } from "next/navigation";

const OPERATION_COLUMNS = [
  { key: "integration", label: "Integration" },
  { key: "configured", label: "Configuration" },
  { key: "posture", label: "Posture" },
] as const;

export default async function OperationsPage({
  searchParams,
}: {
  searchParams: Promise<AdminTableSearchParams>;
}) {
  const parameters = await searchParams;
  const navigation = readAdminTableNavigation(parameters);
  const access = await authorizeAdminPage();
  if (
    access.status === "denied" ||
    !hasRolePermission(access.currentAdmin.roles, "operations", "read")
  ) {
    redirect("/admin/forbidden");
  }

  let result: Awaited<ReturnType<typeof fetchAuthQuery>> | null = null;
  let failed = !navigation.isValid;
  if (!failed) {
    try {
      result = await fetchAuthQuery(
        api.admin.operations.listIntegrationHealth,
        { paginationOpts: { numItems: 20, cursor: navigation.cursor } },
      );
    } catch {
      failed = true;
    }
  }

  const integrations =
    result && "page" in result
      ? result.page as Array<{
          id: string;
          label: string;
          configured: boolean;
          status: "ready" | "configuration_required";
        }>
      : [];

  return (
    <div className="mx-auto max-w-[82rem]">
      <header className="grid gap-5 border-b-2 border-[oklch(35%_0.055_252)] pb-7 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.42fr)] lg:items-end">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[oklch(43%_0.065_67)]">
            Control · deployment posture
          </p>
          <h1 className="mt-3 text-[clamp(2.25rem,6vw,4.75rem)] font-semibold leading-[0.96] tracking-[-0.05em] text-[oklch(23%_0.05_252)]">
            Operations
          </h1>
        </div>
        <p className="max-w-[48ch] text-sm leading-6 text-[oklch(41%_0.035_252)]">
          A secret-free configuration check. This view reports whether required
          settings exist; it never displays credentials or performs provider
          network calls.
        </p>
      </header>

      <aside className="mt-8 border-l-4 border-[oklch(55%_0.1_68)] bg-[oklch(90%_0.036_78)] px-5 py-5 sm:px-7">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[oklch(40%_0.07_65)]">
          Read-only posture
        </p>
        <p className="mt-2 max-w-[70ch] text-sm leading-6 text-[oklch(36%_0.04_252)]">
          Reachability, incidents, retry controls, and retention history arrive
          with the durable operations slice. No mutation is available here.
        </p>
      </aside>

      <div className="mt-8">
        <DataTable
          ariaLabel="Integration health"
          basePath="/admin/operations"
          columns={OPERATION_COLUMNS}
          rows={integrations.map((integration) => ({
            id: integration.id,
            cells: {
              integration: (
                <span className="font-semibold">{integration.label}</span>
              ),
              configured: integration.configured ? "Present" : "Missing",
              posture:
                integration.status === "ready"
                  ? "Ready"
                  : "Configuration required",
            },
          }))}
          currentCursor={navigation.cursor}
          previousCursors={navigation.previousCursors}
          nextCursor={
            result && "continueCursor" in result
              ? result.continueCursor as string
              : ""
          }
          isDone={
            result && "isDone" in result ? result.isDone as boolean : true
          }
          state={failed ? "error" : "ready"}
          emptyMessage="No integration checks are registered."
          errorMessage="Integration posture could not be loaded. Clear the pagination state and try again."
        />
      </div>
    </div>
  );
}
