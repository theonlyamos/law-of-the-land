import Link from "next/link";
import { redirect } from "next/navigation";
import { hasRolePermission } from "../../../../../convex/lib/adminPermissions";
import { GEMINI_MAX_DOCUMENT_BYTES } from "../../../../../shared/gemini-file-types";
import { BatchImport } from "@/components/admin/batch-import";
import { authorizeAdminPage } from "@/lib/admin/server";

export default async function BatchImportPage() {
  const access = await authorizeAdminPage();
  if (access.status === "denied" || !hasRolePermission(access.currentAdmin.roles, "resource", "write") || !hasRolePermission(access.currentAdmin.roles, "document", "write")) redirect("/admin/forbidden");
  const configured = Number(process.env.ADMIN_MAX_DOCUMENT_BYTES);
  const maxBytes = Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured, GEMINI_MAX_DOCUMENT_BYTES) : null;
  return <article className="mx-auto max-w-[82rem]">
    <Link href="/admin/documents" className="inline-flex min-h-11 items-center text-sm font-semibold underline">Back to legal resource register</Link>
    <header className="mb-8 mt-5 border-b-2 border-[oklch(35%_0.055_252)] pb-7"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-[oklch(43%_0.065_67)]">Legal library / Original evidence</p><h1 className="mt-3 text-[clamp(2.25rem,6vw,4.75rem)] font-semibold leading-tight tracking-[-0.05em]">Import judgment batch</h1><p className="mt-4 max-w-[64ch] text-sm leading-6">One manifest, multiple originals, an explicit review for every judgment. Publication and search indexing remain visible throughout.</p></header>
    {maxBytes === null ? <p role="alert">Document uploads are unavailable because the file-size limit is not configured.</p> : <BatchImport userId={access.currentAdmin.userId} maxBytes={maxBytes} />}
  </article>;
}
