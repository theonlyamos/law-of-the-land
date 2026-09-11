import { OrganizationResources } from "@/components/organizations/organization-content";
import type { Id } from "@/convex/_generated/dataModel";
export default async function Page({
  params,
}: {
  params: Promise<{ organizationId: string; jurisdictionId: string }>;
}) {
  const p = await params;
  return (
    <OrganizationResources
      organizationId={p.organizationId as Id<"organizations">}
      jurisdictionId={p.jurisdictionId as Id<"jurisdictions">}
    />
  );
}
