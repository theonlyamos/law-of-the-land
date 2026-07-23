import { AdminOverview } from "@/components/admin/admin-overview";
import { PermissionBoundary } from "@/components/admin/permission-boundary";
import { loadAdminOverview } from "@/lib/admin/server";
import Link from "next/link";

export default async function AdminOverviewPage() {
  // Rechecking here is deliberate: layouts and pages can render concurrently.
  // The helper guarantees `get` is never issued before this page's own
  // authoritative currentAdmin check succeeds.
  const { overview } = await loadAdminOverview();
  if (overview) {
    return <AdminOverview overview={overview} />;
  }

  return (
    <div className="mx-auto max-w-5xl">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[oklch(43%_0.065_67)]">
        Permission-aware workspace
      </p>
      <h1 className="mt-3 max-w-4xl text-balance text-[clamp(2.25rem,7vw,5rem)] font-semibold leading-[0.96] tracking-[-0.055em]">
        Your administration workspace
      </h1>
      <p className="mt-6 max-w-[62ch] text-base leading-7 text-[oklch(42%_0.035_252)]">
        The site-wide operations overview is not included in your role. Use
        the permitted areas below to continue your work.
      </p>
      <div className="mt-10 flex flex-wrap gap-3 border-t border-[oklch(68%_0.035_78)] pt-6">
        <PermissionBoundary resource="user" action="read">
          <Link
            href="/admin/users"
            className="inline-flex min-h-11 items-center bg-[oklch(28%_0.055_252)] px-5 text-sm font-semibold text-[oklch(97%_0.012_82)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
          >
            Open users
          </Link>
        </PermissionBoundary>
        <PermissionBoundary resource="conversation" action="read_content">
          <Link
            href="/admin/conversations"
            className="inline-flex min-h-11 items-center px-4 text-sm font-semibold underline decoration-[oklch(58%_0.1_68)] decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
          >
            Open conversations
          </Link>
        </PermissionBoundary>
        <PermissionBoundary resource="document" action="read">
          <Link
            href="/admin/documents"
            className="inline-flex min-h-11 items-center px-4 text-sm font-semibold underline decoration-[oklch(58%_0.1_68)] decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
          >
            Open documents
          </Link>
        </PermissionBoundary>
      </div>
    </div>
  );
}
