import { api } from "../../../../convex/_generated/api";
import { hasRolePermission } from "../../../../convex/lib/adminPermissions";
import { DocumentReview, type ReviewItem } from "@/components/admin/document-review";
import { authorizeAdminPage } from "@/lib/admin/server";
import { fetchAuthQuery } from "@/lib/auth-server";
import { redirect } from "next/navigation";

export default async function ReviewQueuePage() {
  const access = await authorizeAdminPage();
  if (
    access.status === "denied" ||
    (!hasRolePermission(access.currentAdmin.roles, "document", "read") &&
      !hasRolePermission(access.currentAdmin.roles, "document", "review"))
  ) {
    redirect("/admin/forbidden");
  }
  const dockets = await Promise.all(
    (["ready_for_review", "approved", "published", "superseded"] as const).map((status) =>
      fetchAuthQuery(api.admin.reviews.listReviewQueue, {
        status,
        paginationOpts: { numItems: 12, cursor: null },
      }),
    ),
  );
  const items = dockets.flatMap((docket) => docket.page) as ReviewItem[];

  return (
    <article className="mx-auto max-w-[88rem]">
      <header className="grid gap-5 border-b-2 border-[oklch(35%_0.055_252)] pb-8 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-end">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[oklch(43%_0.065_67)]">Legal library / Independent review</p>
          <h1 className="mt-3 max-w-[15ch] text-[clamp(2.2rem,6vw,4.8rem)] font-semibold leading-[0.94] tracking-[-0.055em] text-[oklch(23%_0.05_252)]">The publication docket</h1>
        </div>
        <p className="text-sm leading-6 text-[oklch(40%_0.035_252)]">Inspect the immutable original metadata, record a legal decision, then publish the approved version through Gemini.</p>
      </header>
      <div className="mt-10">
        <DocumentReview items={items} />
      </div>
      {dockets.some((docket) => !docket.isDone) ? <p className="mt-10 border-t border-[oklch(75%_0.025_78)] pt-5 text-sm">More docket entries are available through the bounded review cursors.</p> : null}
    </article>
  );
}
