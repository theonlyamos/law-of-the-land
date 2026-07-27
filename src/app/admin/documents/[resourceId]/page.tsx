import { api } from "../../../../../convex/_generated/api";
import type { Doc, Id } from "../../../../../convex/_generated/dataModel";
import { hasRolePermission } from "../../../../../convex/lib/adminPermissions";
import { CatalogStatus, VersionHistory } from "@/components/admin/resource-register";
import { ResourceEditor } from "@/components/admin/catalog-actions";
import { DocumentUpload } from "@/components/admin/document-upload";
import { authorizeAdminPage } from "@/lib/admin/server";
import { fetchAuthQuery } from "@/lib/auth-server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

export default async function ResourceDetailPage({ params }: { params: Promise<{ resourceId: string }> }) {
  const { resourceId: rawResourceId } = await params;
  const access = await authorizeAdminPage();
  if (
    access.status === "denied" ||
    (!hasRolePermission(access.currentAdmin.roles, "resource", "read") &&
      !hasRolePermission(access.currentAdmin.roles, "resource", "write"))
  ) redirect("/admin/forbidden");
  const canWrite = hasRolePermission(access.currentAdmin.roles, "resource", "write");
  const canUpload = hasRolePermission(access.currentAdmin.roles, "document", "write");
  const configuredUploadLimit = Number(process.env.ADMIN_MAX_DOCUMENT_BYTES);
  const uploadLimit = Number.isSafeInteger(configuredUploadLimit) && configuredUploadLimit > 0
    ? configuredUploadLimit
    : null;
  const resourceId = rawResourceId as Id<"legalResources">;
  let resource: Awaited<ReturnType<typeof fetchAuthQuery>>;
  let versions: Awaited<ReturnType<typeof fetchAuthQuery>>;
  try {
    [resource, versions] = await Promise.all([
      fetchAuthQuery(api.admin.resources.getResource, { id: resourceId }),
      fetchAuthQuery(api.admin.resources.listVersions, { resourceId, paginationOpts: { numItems: 50, cursor: null } }),
    ]);
  } catch { notFound(); }

  return (
    <article className="mx-auto max-w-[82rem]">
      <Link href="/admin/documents" className="inline-flex min-h-11 items-center text-sm font-semibold underline decoration-2 decoration-amber-700 underline-offset-4">Back to legal resource register</Link>
      <header className="mt-5 border-b-2 border-[oklch(35%_0.055_252)] pb-7">
        <div className="flex flex-wrap items-center gap-3"><CatalogStatus status={resource.status} /><span className="text-xs font-semibold uppercase tracking-[0.14em]">{resource.jurisdiction.code} / {resource.type}</span></div>
        <h1 className="mt-4 max-w-[20ch] text-[clamp(2rem,5vw,4rem)] font-semibold leading-[0.98] tracking-[-0.045em] text-[oklch(23%_0.05_252)]">{resource.title}</h1>
        <p className="mt-4 text-sm leading-6 text-[oklch(40%_0.035_252)]">{resource.officialCitation} / Issued by {resource.issuer}</p>
      </header>
      <dl className="grid gap-x-8 gap-y-5 border-b border-[oklch(74%_0.028_78)] py-7 sm:grid-cols-2 lg:grid-cols-4">
        <div><dt className="text-xs font-semibold uppercase tracking-[0.12em]">Jurisdiction</dt><dd className="mt-2 text-sm">{resource.jurisdiction.name}</dd></div>
        <div><dt className="text-xs font-semibold uppercase tracking-[0.12em]">Effective date</dt><dd className="mt-2 text-sm">{resource.effectiveDate}</dd></div>
        <div><dt className="text-xs font-semibold uppercase tracking-[0.12em]">Topics</dt><dd className="mt-2 text-sm">{resource.topics.join(", ") || "None assigned"}</dd></div>
        <div><dt className="text-xs font-semibold uppercase tracking-[0.12em]">Official source</dt><dd className="mt-2 text-sm"><a href={resource.sourceUrl} target="_blank" rel="noreferrer" className="break-all underline decoration-2 decoration-amber-700 underline-offset-4">Open source record</a></dd></div>
      </dl>
      {canWrite ? (
        <section className="mt-10" aria-labelledby="resource-actions-heading">
          <h2 id="resource-actions-heading" className="mb-4 text-xl font-semibold tracking-[-0.025em]">Metadata and lifecycle actions</h2>
          <ResourceEditor jurisdictionIds={[resource.jurisdictionId]} resource={{ id: resource._id, jurisdictionId: resource.jurisdictionId, type: resource.type, title: resource.title, issuer: resource.issuer, officialCitation: resource.officialCitation, sourceUrl: resource.sourceUrl, topics: resource.topics, effectiveDate: resource.effectiveDate, repealDate: resource.repealDate, status: resource.status }} />
        </section>
      ) : null}
      {canUpload ? (
        <section className="mt-10" aria-label="Original document upload">
          {uploadLimit === null ? (
            <p role="alert" className="border-y border-[oklch(64%_0.09_45)] bg-[oklch(95%_0.035_55)] px-5 py-5 text-sm font-medium text-[oklch(34%_0.08_35)]">
              Original uploads are unavailable until the document size policy is configured.
            </p>
          ) : (
            <DocumentUpload
              resourceId={resource._id}
              defaultSourceUrl={resource.sourceUrl}
              defaultEffectiveAt={resource.effectiveDate}
              maxBytes={uploadLimit}
            />
          )}
        </section>
      ) : null}
      <section className="mt-10" aria-labelledby="version-history-heading">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-[oklch(43%_0.065_67)]">Immutable originals</p><h2 id="version-history-heading" className="mt-2 text-2xl font-semibold tracking-[-0.03em]">Version and review history</h2></div><p className="max-w-[42ch] text-sm text-[oklch(42%_0.035_252)]">Metadata only. Original file bodies are never downloaded by this register.</p></div>
        <VersionHistory versions={(versions.page as Doc<"documentVersions">[]).map((version) => ({ id: version._id, versionNumber: version.versionNumber, filename: version.filename, mimeType: version.mimeType, byteSize: version.byteSize, sha256: version.sha256, status: version.status, createdAt: version.createdAt }))} />
      </section>
    </article>
  );
}
