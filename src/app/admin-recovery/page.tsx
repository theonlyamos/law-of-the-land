import { AdminRecoveryControl } from "@/components/admin/admin-recovery-control";
import { UnifiedJurisdictionsRecoveryControl } from "@/components/admin/unified-jurisdictions-recovery-control";
import { fetchAuthQuery } from "@/lib/auth-server";
import { authorizeAdminRecoveryPage } from "@/lib/admin/server";
import { api } from "../../../convex/_generated/api";
import Link from "next/link";
import { redirect } from "next/navigation";

export default async function AdminRecoveryPage() {
  const access = await authorizeAdminRecoveryPage();
  if (access.status === "denied") redirect("/admin/forbidden");
  const rollout = await fetchAuthQuery(
    api.admin.featureFlags.getUnifiedJurisdictionRolloutState,
    {},
  ).catch(() => null);

  return (
    <main className="min-h-screen bg-[oklch(96%_0.016_82)] text-[oklch(24%_0.035_252)]">
      <div className="mx-auto w-full max-w-5xl px-5 py-[clamp(3rem,8vw,7rem)] sm:px-8">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[oklch(44%_0.07_65)]">
          Restricted recovery surface
        </p>
        <h1 className="mt-4 max-w-4xl text-balance text-[clamp(2.6rem,8vw,5.8rem)] font-semibold leading-[0.92] tracking-[-0.06em]">
          Restore the control plane without bypassing its controls.
        </h1>
        <p className="mt-7 max-w-[64ch] text-base leading-7 text-[oklch(39%_0.035_252)]">
          Available only to an assured, non-impersonated Super Admin. Every change requires a fresh password proof, an exact confirmation, a reason, and an idempotency key.
        </p>
        <AdminRecoveryControl {...access.state} />
        {rollout ? (
          <UnifiedJurisdictionsRecoveryControl rollout={rollout} />
        ) : (
          <section className="mt-6 border border-amber-700/30 bg-white/70 p-5">
            <h2 className="text-lg font-semibold">Unified jurisdictions unavailable</h2>
            <p className="mt-2 text-sm leading-6 text-[oklch(39%_0.035_252)]">
              Rollout readiness could not be loaded. Admin-panel recovery remains available above; retry unified-jurisdiction recovery after the rollout service is healthy.
            </p>
          </section>
        )}
        <p className="mt-8 text-sm leading-6">
          <Link href="/" className="font-semibold underline decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700">
            Return to the public site
          </Link>
        </p>
      </div>
    </main>
  );
}
