import { api } from "../../../../convex/_generated/api";
import { hasRolePermission } from "../../../../convex/lib/adminPermissions";
import { DataTable, readAdminTableNavigation, type AdminTableSearchParams } from "@/components/admin/data-table";
import { JobActions } from "@/components/admin/job-actions";
import { authorizeAdminPage } from "@/lib/admin/server";
import { fetchAuthQuery } from "@/lib/auth-server";
import { redirect } from "next/navigation";

const JOB_STATUSES = ["queued", "running", "waiting_callback", "succeeded", "failed", "cancelled", "manual_review"] as const;
const JOB_TYPES = ["create_bucket", "ingest_remote", "copy_documents", "delete_documents", "poll_process"] as const;
function exact<T extends readonly string[]>(value: string | string[] | undefined, allowed: T): T[number] | undefined | null { if (value === undefined) return undefined; if (Array.isArray(value) || !allowed.includes(value as never)) return null; return value as T[number]; }

export default async function OperationsPage({ searchParams }: { searchParams: Promise<AdminTableSearchParams> }) {
  const parameters = await searchParams;
  const navigation = readAdminTableNavigation(parameters);
  const status = exact(parameters.status, JOB_STATUSES);
  const type = exact(parameters.type, JOB_TYPES);
  const access = await authorizeAdminPage();
  if (access.status === "denied" || !hasRolePermission(access.currentAdmin.roles, "operations", "read")) redirect("/admin/forbidden");
  const invalid = !navigation.isValid || status === null || type === null;
  let failed = invalid;
  let integrations: { page: Array<{ id: string; label: string; configured: boolean; status: string }>; isDone: boolean; continueCursor: string } = { page: [], isDone: true, continueCursor: "" };
  let jobs: { page: Array<{ id: string; type: string; targetType: string; targetId: string; status: string; attemptCount: number; lastErrorKind?: string; correlationId: string; createdAt: number; updatedAt: number }>; isDone: boolean; continueCursor: string } = { page: [], isDone: true, continueCursor: "" };
  let policy = { queryRunDays: 90, exportHours: 24, unattachedStorageHours: 24, maxPerInvocation: 200, lastSuccessfulAt: null as number | null, deletedTotal: 0 };
  if (!invalid) {
    try {
      [integrations, jobs, policy] = await Promise.all([
        fetchAuthQuery(api.admin.operations.listIntegrationHealth, { paginationOpts: { numItems: 20, cursor: null } }) as never,
        fetchAuthQuery(api.admin.jobs.listJobs, { paginationOpts: { numItems: 30, cursor: navigation.cursor }, status, type }) as never,
        fetchAuthQuery(api.admin.operations.getRetentionPolicy, {}) as never,
      ]);
    } catch { failed = true; }
  }
  jobs = {
    ...jobs,
    page: jobs.page.filter((row) =>
      typeof row.type === "string" &&
      typeof row.status === "string" &&
      typeof row.correlationId === "string",
    ),
  };
  policy = {
    queryRunDays: Number.isFinite(policy.queryRunDays) ? policy.queryRunDays : 90,
    exportHours: Number.isFinite(policy.exportHours) ? policy.exportHours : 24,
    unattachedStorageHours: Number.isFinite(policy.unattachedStorageHours) ? policy.unattachedStorageHours : 24,
    maxPerInvocation: Number.isFinite(policy.maxPerInvocation) ? policy.maxPerInvocation : 200,
    lastSuccessfulAt: typeof policy.lastSuccessfulAt === "number" ? policy.lastSuccessfulAt : null,
    deletedTotal: Number.isFinite(policy.deletedTotal) ? policy.deletedTotal : 0,
  };
  const canWrite = hasRolePermission(access.currentAdmin.roles, "operations", "write");
  const canRetry = hasRolePermission(access.currentAdmin.roles, "operations", "retry");
  return <div className="mx-auto max-w-[88rem]">
    <header className="grid gap-5 border-b-2 border-[oklch(35%_0.055_252)] pb-7 lg:grid-cols-[1fr_0.45fr] lg:items-end"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-[oklch(43%_0.065_67)]">Control · durable work</p><h1 className="mt-3 text-[clamp(2.25rem,6vw,4.75rem)] font-semibold leading-[0.96] tracking-[-0.05em] text-[oklch(23%_0.05_252)]">Operations</h1></div><p className="text-sm leading-6 text-[oklch(41%_0.035_252)]">Authoritative provider state, bounded operator controls, and the active deletion policy. Secret values and raw provider responses never enter this register.</p></header>
    <section aria-label="Retention policy" className="mt-8 grid gap-px border border-[oklch(73%_0.03_78)] bg-[oklch(73%_0.03_78)] sm:grid-cols-2 lg:grid-cols-5">
      {[['Detailed telemetry', `${policy.queryRunDays} days`], ['Generated exports', `${policy.exportHours} hours`], ['Unattached uploads', `${policy.unattachedStorageHours} hours`], ['Transaction cap', `${policy.maxPerInvocation} rows`], ['Last complete run', policy.lastSuccessfulAt ? new Date(policy.lastSuccessfulAt).toLocaleString('en-GB', { timeZone: 'UTC' }) : 'Awaiting first run']].map(([label, value]) => <div key={label} className="bg-[oklch(96%_0.014_82)] p-5"><p className="text-xs font-semibold uppercase tracking-[0.13em] text-[oklch(43%_0.05_252)]">{label}</p><p className="mt-2 text-lg font-semibold text-[oklch(24%_0.05_252)]">{value}</p></div>)}
    </section>
    <section className="mt-10"><h2 className="mb-4 text-2xl font-semibold tracking-[-0.03em]">Provider jobs</h2><DataTable ariaLabel="Provider jobs" basePath="/admin/operations" columns={[{ key: 'job', label: 'Job' }, { key: 'target', label: 'Target' }, { key: 'state', label: 'State' }, { key: 'control', label: 'Control' }]} filters={[{ name: 'status', label: 'Status', value: status ?? '', options: [{ value: '', label: 'All states' }, ...JOB_STATUSES.map((value) => ({ value, label: value.replaceAll('_', ' ') }))] }, { name: 'type', label: 'Job type', value: type ?? '', options: [{ value: '', label: 'All types' }, ...JOB_TYPES.map((value) => ({ value, label: value.replaceAll('_', ' ') }))] }]} rows={jobs.page.map((job) => ({ id: job.id, cells: { job: <><span className="font-semibold">{job.type.replaceAll('_', ' ')}</span><span className="mt-1 block font-mono text-xs">{job.correlationId}</span></>, target: `${job.targetType} · ${job.targetId}`, state: <><span className="font-semibold">{job.status.replaceAll('_', ' ')}</span><span className="mt-1 block text-xs">Attempt {job.attemptCount}</span></>, control: <JobActions jobId={job.id as never} status={job.status as never} canRetry={canRetry} canCancel={canWrite} /> } }))} currentCursor={navigation.cursor} previousCursors={navigation.previousCursors} nextCursor={jobs.continueCursor} isDone={jobs.isDone} state={failed ? 'error' : 'ready'} /></section>
    <section className="mt-10"><h2 className="mb-4 text-2xl font-semibold tracking-[-0.03em]">Integration posture</h2><DataTable ariaLabel="Integration health" basePath="/admin/operations" columns={[{ key: 'integration', label: 'Integration' }, { key: 'configuration', label: 'Configuration' }, { key: 'posture', label: 'Posture' }]} rows={integrations.page.map((row) => ({ id: row.id, cells: { integration: row.label, configuration: row.configured ? 'Present' : 'Missing', posture: row.status === 'ready' ? 'Ready' : 'Configuration required' } }))} currentCursor={null} previousCursors={[]} nextCursor="" isDone state={failed ? 'error' : 'ready'} /></section>
  </div>;
}
