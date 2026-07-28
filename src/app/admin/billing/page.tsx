import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { hasRolePermission } from "../../../../convex/lib/adminPermissions";
import { BillingActions, BillingAllowanceSummary } from "@/components/admin/billing-actions";
import { authorizeAdminPage } from "@/lib/admin/server";
import { fetchAuthQuery } from "@/lib/auth-server";
import Link from "next/link";
import { redirect } from "next/navigation";

type Override = null | { id: Id<"quotaOverrides">; limit: number; startsAt: number; expiresAt: number; grantedBy: string; reason: string };
type Usage = { userId: string; used: number; baseLimit: number; effectiveLimit: number; allowed: boolean; canRecord: boolean; isPro: boolean; override: Override };
type Subscription = { userId: string; plan: "free" | "pro"; status: string | null; currentPeriodStart: string | null; currentPeriodEnd: string | null; used: number; baseLimit: number; effectiveLimit: number; allowed: boolean; canRecord: boolean; override: Override };

export default async function AdminBillingPage({ searchParams }: { searchParams: Promise<{ subscriptionsCursor?: string; usageCursor?: string }> }) {
  const access = await authorizeAdminPage();
  if (access.status === "denied" || !hasRolePermission(access.currentAdmin.roles, "billing", "read")) redirect("/admin/forbidden");
  const canWrite = hasRolePermission(access.currentAdmin.roles, "billing", "write");
  const parameters = await searchParams;
  let failed = false;
  let subscriptions: { page: Subscription[]; isDone: boolean; continueCursor: string } = { page: [], isDone: true, continueCursor: "" };
  let usage: { page: Usage[]; isDone: boolean; continueCursor: string } = { page: [], isDone: true, continueCursor: "" };
  try {
    [subscriptions, usage] = await Promise.all([
      fetchAuthQuery(api.admin.billing.listSubscriptions, { paginationOpts: { numItems: 25, cursor: parameters.subscriptionsCursor ?? null } }),
      fetchAuthQuery(api.admin.billing.listUsage, { paginationOpts: { numItems: 25, cursor: parameters.usageCursor ?? null } }),
    ]);
  } catch { failed = true; }

  const summary = (row: Usage | Subscription) => <BillingAllowanceSummary used={row.used} effectiveLimit={row.effectiveLimit} allowed={row.allowed} canRecord={row.canRecord} override={row.override} />;

  return <div className="mx-auto max-w-[90rem]">
    <header className="grid gap-5 border-b-2 border-[oklch(35%_0.055_252)] pb-7 lg:grid-cols-[1fr_28rem] lg:items-end">
      <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-[oklch(43%_0.065_67)]">Control / account allowances</p><h1 className="mt-3 text-[clamp(2.25rem,6vw,4.75rem)] font-semibold leading-[0.96] tracking-[-0.05em]">Billing</h1></div>
      <p className="text-sm leading-6 text-slate-700">Polar remains the subscription record. Temporary local overrides expire automatically and every change enters the governance ledger.</p>
    </header>
    {failed ? <p role="alert" className="mt-8 border border-red-800 bg-red-50 p-4 text-red-950">Billing records could not be loaded. No subscription or allowance was changed.</p> : null}
    <section className="mt-10" aria-labelledby="subscriptions-heading">
      <h2 id="subscriptions-heading" className="font-serif text-2xl font-semibold">Subscription register</h2>
      <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[58rem] border-collapse text-left text-sm"><thead><tr className="border-y-2 border-slate-700"><th className="p-3">Account</th><th className="p-3">Polar plan</th><th className="p-3">Status</th><th className="p-3">Allowance</th><th className="p-3">Current period</th><th className="p-3">Administration</th></tr></thead><tbody>{subscriptions.page.map((row) => <tr key={row.userId} className="border-b border-slate-300 align-top"><td className="p-3 font-semibold">{row.userId}</td><td className="p-3 capitalize">{row.plan}</td><td className="p-3">{row.status ?? "No active subscription"}</td><td className="p-3">{summary(row)}</td><td className="p-3">{row.currentPeriodStart ?? "—"}<br />{row.currentPeriodEnd ?? "—"}</td><td className="p-3">{canWrite ? <BillingActions userId={row.userId} activeOverrideId={row.override?.id} /> : "Read only"}</td></tr>)}</tbody></table></div>
      {!subscriptions.isDone ? <Link className="mt-4 inline-flex min-h-11 items-center font-semibold underline decoration-2 decoration-amber-700 underline-offset-4" href={`/admin/billing?subscriptionsCursor=${encodeURIComponent(subscriptions.continueCursor)}`}>Next subscription page</Link> : null}
    </section>
    <section className="mt-14" aria-labelledby="usage-heading">
      <h2 id="usage-heading" className="font-serif text-2xl font-semibold">Today’s UTC usage</h2><p className="mt-2 text-sm text-slate-700">The window runs from 00:00 UTC up to, but not including, the next midnight.</p>
      <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[54rem] border-collapse text-left text-sm"><thead><tr className="border-y-2 border-slate-700"><th className="p-3">Account</th><th className="p-3">Polar base</th><th className="p-3">Effective allowance</th></tr></thead><tbody>{usage.page.map((row) => <tr key={row.userId} className="border-b border-slate-300 align-top"><td className="p-3 font-semibold">{row.userId}</td><td className="p-3">{row.baseLimit}</td><td className="p-3">{summary(row)}</td></tr>)}</tbody></table></div>
      {!usage.isDone ? <Link className="mt-4 inline-flex min-h-11 items-center font-semibold underline decoration-2 decoration-amber-700 underline-offset-4" href={`/admin/billing?usageCursor=${encodeURIComponent(usage.continueCursor)}`}>Next usage page</Link> : null}
    </section>
  </div>;
}
