import { Suspense } from "react";
import { OrganizationJurisdictions } from "@/components/organizations/jurisdiction-management";
import type { Id } from "@/convex/_generated/dataModel";
export default async function Page({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  return (
    <Suspense fallback={<p role="status">Loading jurisdictions…</p>}>
      <OrganizationJurisdictions
        organizationId={(await params).organizationId as Id<"organizations">}
      />
    </Suspense>
  );
}
