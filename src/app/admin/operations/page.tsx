import { api } from "../../../../convex/_generated/api";
import { hasRolePermission } from "../../../../convex/lib/adminPermissions";
import { DataTable, readAdminTableNavigation, type AdminTableSearchParams } from "@/components/admin/data-table";
import { JobActions } from "@/components/admin/job-actions";
import { authorizeAdminPage } from "@/lib/admin/server";
import { fetchAuthQuery } from "@/lib/auth-server";
import type { FunctionReturnType } from "convex/server";
import { redirect } from "next/navigation";

type OperationJob = FunctionReturnType<typeof api.admin.jobs.listJobs>["page"][number];
type JobType = OperationJob["type"];
type JobStatus = OperationJob["status"];

const JOB_STATUSES = ["queued", "running", "waiting_provider", "succeeded", "failed", "cancelled", "manual_review"] as const satisfies readonly JobStatus[];
const JOB_TYPES = ["gemini_create_store", "gemini_index_document", "gemini_delete_document", "gemini_delete_store"] as const satisfies readonly JobType[];
const JOB_LABELS = {
  gemini_create_store: "Set up jurisdiction search",
  gemini_index_document: "Index document",
  gemini_delete_document: "Remove indexed document",
  gemini_delete_store: "Remove jurisdiction search store",
} satisfies Record<JobType, string>;
const PROVIDER_OPERATION_LABELS = {
  store_create: "jurisdiction search setup",
  document_upload: "document upload",
  operation_poll: "index status check",
  store_get: "search-store lookup",
  document_delete: "indexed-document removal",
  store_delete: "search-store removal",
} satisfies Record<NonNullable<OperationJob["lastProviderOperation"]>, string>;
const STATUS_LABELS = {
  queued: "Queued",
  running: "Running",
  waiting_provider: "Waiting for Gemini",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  manual_review: "Needs review",
} satisfies Record<JobStatus, string>;
function exact<T extends readonly string[]>(value: string | string[] | undefined, allowed: T): T[number] | undefined | null { if (value === undefined) return undefined; if (Array.isArray(value) || !allowed.includes(value as never)) return null; return value as T[number]; }

function targetLabel(targetType: string) {
  if (targetType === "documentVersion") return "Document";
  if (targetType === "jurisdiction" || targetType === "jurisdictionGeminiStore") return "Jurisdiction";
  if (targetType === "operation") return "Provider work";
  if (targetType === "e2e_fixture") return "Fixture record";
  return "Related record";
}

function nextCheckText(nextAttemptAt: number | undefined, now = Date.now()) {
  if (nextAttemptAt === undefined) return null;
  const seconds = Math.max(0, Math.ceil((nextAttemptAt - now) / 1_000));
  if (seconds < 60) return `Next check in ${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  const minutes = Math.ceil(seconds / 60);
  return `Next check in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

function providerDiagnosticText(job: Pick<OperationJob, "lastProviderOperation" | "lastProviderStatus">) {
  if (job.lastProviderOperation === undefined || job.lastProviderStatus === undefined) return null;
  const operation = PROVIDER_OPERATION_LABELS[job.lastProviderOperation];
  if (job.lastProviderStatus === 401) return `Gemini rejected the API credential during ${operation} (HTTP 401).`;
  if (job.lastProviderStatus === 403) return `Gemini denied ${operation} (HTTP 403).`;
  return `Gemini ${operation} returned HTTP ${job.lastProviderStatus}.`;
}

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
  let jobs: { page: OperationJob[]; isDone: boolean; continueCursor: string } = { page: [], isDone: true, continueCursor: "" };
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
    <header className="grid gap-5 border-b-2 border-[oklch(35%_0.055_252)] pb-7 lg:grid-cols-[1fr_0.45fr] lg:items-end"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-[oklch(43%_0.065_67)]">Control · durable work</p><h1 className="mt-3 text-[clamp(2.25rem,6vw,4.75rem)] font-semibold leading-[0.96] tracking-[-0.05em] text-[oklch(23%_0.05_252)]">Operations</h1></div><p className="text-sm leading-6 text-[oklch(41%_0.035_252)]">Authoritative provider state, bounded operator controls, and the active deletion policy. Failed Gemini jobs temporarily retain their raw provider response for super-administrator diagnostics.</p></header>
    <section aria-label="Retention policy" className="mt-8 grid gap-px border border-[oklch(73%_0.03_78)] bg-[oklch(73%_0.03_78)] sm:grid-cols-2 lg:grid-cols-5">
      {[['Detailed telemetry', `${policy.queryRunDays} days`], ['Generated exports', `${policy.exportHours} hours`], ['Unattached uploads', `${policy.unattachedStorageHours} hours`], ['Transaction cap', `${policy.maxPerInvocation} rows`], ['Last complete run', policy.lastSuccessfulAt ? new Date(policy.lastSuccessfulAt).toLocaleString('en-GB', { timeZone: 'UTC' }) : 'Awaiting first run']].map(([label, value]) => <div key={label} className="bg-[oklch(96%_0.014_82)] p-5"><p className="text-xs font-semibold uppercase tracking-[0.13em] text-[oklch(43%_0.05_252)]">{label}</p><p className="mt-2 text-lg font-semibold text-[oklch(24%_0.05_252)]">{value}</p></div>)}
    </section>
    <section className="mt-10"><h2 className="mb-4 text-2xl font-semibold tracking-[-0.03em]">Provider jobs</h2><DataTable ariaLabel="Provider jobs" basePath="/admin/operations" columns={[{ key: 'job', label: 'Job' }, { key: 'target', label: 'Target' }, { key: 'state', label: 'State' }, { key: 'control', label: 'Control' }]} filters={[{ name: 'status', label: 'Status', value: status ?? '', options: [{ value: '', label: 'All states' }, ...JOB_STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] }))] }, { name: 'type', label: 'Job type', value: type ?? '', options: [{ value: '', label: 'All types' }, ...JOB_TYPES.map((value) => ({ value, label: JOB_LABELS[value] }))] }]} rows={jobs.page.map((job) => { const nextCheck = job.status === 'waiting_provider' ? nextCheckText(job.nextAttemptAt) : null; const indexingNeedsReview = job.type === 'gemini_index_document' && job.status === 'manual_review'; const providerDiagnostic = providerDiagnosticText(job); return { id: job.id, cells: { job: <><span className="font-semibold">{JOB_LABELS[job.type]}</span><span className="mt-1 block font-mono text-xs">{job.correlationId}</span></>, target: targetLabel(job.targetType), state: <><span className="font-semibold">{indexingNeedsReview ? 'Indexing needs review' : STATUS_LABELS[job.status]}</span><span className="mt-1 block text-xs">Attempt {job.attemptCount}</span>{nextCheck ? <span className="mt-1 block text-xs">{nextCheck}</span> : null}{indexingNeedsReview ? <span className="mt-1 block text-xs">Search is paused until an administrator reviews the job.</span> : null}{job.lastErrorKind ? <span className="mt-1 block text-xs">Failure category: {job.lastErrorKind.replaceAll('_', ' ')}</span> : null}{providerDiagnostic ? <span className="mt-1 block text-xs">{providerDiagnostic}</span> : null}{job.lastProviderRawResponse ? <pre className="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded border border-[oklch(73%_0.03_78)] bg-[oklch(98%_0.01_82)] p-2 font-mono text-xs text-[oklch(31%_0.04_252)]">{job.lastProviderRawResponse}</pre> : null}</>, control: <JobActions jobId={job.id as never} status={job.status} canRetry={canRetry} canCancel={canWrite} /> } }; })} currentCursor={navigation.cursor} previousCursors={navigation.previousCursors} nextCursor={jobs.continueCursor} isDone={jobs.isDone} state={failed ? 'error' : 'ready'} /></section>
    <section className="mt-10"><h2 className="mb-4 text-2xl font-semibold tracking-[-0.03em]">Integration configuration</h2><DataTable ariaLabel="Integration configuration" basePath="/admin/operations" columns={[{ key: 'integration', label: 'Integration' }, { key: 'configuration', label: 'Configuration' }, { key: 'posture', label: 'Posture' }]} rows={integrations.page.map((row) => ({ id: row.id, cells: { integration: row.label, configuration: row.configured ? 'Present' : 'Missing', posture: row.status === 'configured' ? 'Configured' : 'Configuration required' } }))} currentCursor={null} previousCursors={[]} nextCursor="" isDone state={failed ? 'error' : 'ready'} /></section>
  </div>;
}
