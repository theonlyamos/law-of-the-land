import { OrganizationDocument } from "@/components/organizations/organization-content";
import type { Id } from "@/convex/_generated/dataModel";
export default async function Page({
  params,
}: {
  params: Promise<{
    organizationId: string;
    jurisdictionId: string;
    resourceId: string;
  }>;
}) {
  const p = await params;
  return (
    <OrganizationDocument
      organizationId={p.organizationId as Id<"organizations">}
      jurisdictionId={p.jurisdictionId as Id<"jurisdictions">}
      resourceId={p.resourceId as Id<"legalResources">}
    />
  );
}
