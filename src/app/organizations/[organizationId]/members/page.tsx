import { Suspense } from "react";
import { OrganizationMembers } from "@/components/organizations/organization-members";
import type { Id } from "@/convex/_generated/dataModel";
export default async function Page({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  return (
    <Suspense fallback={<p role="status">Loading members…</p>}>
      <OrganizationMembers
        organizationId={(await params).organizationId as Id<"organizations">}
      />
    </Suspense>
  );
}
