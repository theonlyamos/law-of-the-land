import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { hasRolePermission } from "../../../../convex/lib/adminPermissions";
import { DataTable, readAdminTableNavigation, type AdminTableSearchParams } from "@/components/admin/data-table";
import { IncidentActions, IncidentCreateForm } from "@/components/admin/incident-actions";
import { authorizeAdminPage } from "@/lib/admin/server";
import { fetchAuthQuery } from "@/lib/auth-server";
import { redirect } from "next/navigation";
const STATUSES = ["open", "investigating", "monitoring", "resolved"] as const;
const SEVERITIES = ["low", "medium", "high", "critical"] as const;
function exact<T extends readonly string[]>(value: string | string[] | undefined, values: T): T[number] | undefined | null { if (value === undefined) return undefined; return Array.isArray(value) || !values.includes(value as never) ? null : value as T[number]; }
export default async function IncidentsPage({ searchParams }: { searchParams: Promise<AdminTableSearchParams> }) {
  const parameters = await searchParams; const navigation = readAdminTableNavigation(parameters);
  const status = exact(parameters.status, STATUSES); const severity = exact(parameters.severity, SEVERITIES);
  const access = await authorizeAdminPage();
  if (access.status === "denied" || !hasRolePermission(access.currentAdmin.roles, "operations", "read")) redirect("/admin/forbidden");
  const canWrite = hasRolePermission(access.currentAdmin.roles, "operations", "write");
  let failed = !navigation.isValid || status === null || severity === null;
  let result = { page: [] as Array<{ id: string; title: string; severity: string; status: string; ownerId?: string }>, isDone: true, continueCursor: "" };
  if (!failed) try { result = await fetchAuthQuery(api.admin.operations.listIncidents, { paginationOpts: { numItems: 30, cursor: navigation.cursor }, status: status || undefined, severity: severity || undefined }) as never; } catch { failed = true; }
  return <div className="mx-auto max-w-[88rem]"><header className="border-b-2 border-slate-700 pb-7"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-800">Control · response docket</p><h1 className="mt-3 text-5xl font-semibold tracking-[-0.05em]">Incidents</h1><p className="mt-4 max-w-2xl text-sm leading-6 text-slate-700">Owned operational investigations with immutable notes and status history.</p></header><IncidentCreateForm canWrite={canWrite} /><div className="mt-8"><DataTable ariaLabel="System incidents" basePath="/admin/incidents" columns={[{ key: "incident", label: "Incident" }, { key: "severity", label: "Severity" }, { key: "status", label: "Status" }, { key: "owner", label: "Owner" }, { key: "details", label: "Details" }]} filters={[{ name: "status", label: "Status", value: status ?? "", options: [{ value: "", label: "All states" }, ...STATUSES.map((value) => ({ value, label: value }))] }, { name: "severity", label: "Severity", value: severity ?? "", options: [{ value: "", label: "All severities" }, ...SEVERITIES.map((value) => ({ value, label: value }))] }]} rows={result.page.map((row) => ({ id: row.id, cells: { incident: <span className="font-semibold">{row.title}</span>, severity: row.severity, status: row.status, owner: row.ownerId ?? "Unassigned", details: <IncidentActions incidentId={row.id as Id<"systemIncidents">} canWrite={canWrite} status={row.status as typeof STATUSES[number]} severity={row.severity as typeof SEVERITIES[number]} ownerId={row.ownerId} /> } }))} currentCursor={navigation.cursor} previousCursors={navigation.previousCursors} nextCursor={result.continueCursor} isDone={result.isDone} state={failed ? "error" : "ready"} /></div></div>;
}
