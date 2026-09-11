import { JurisdictionSettings } from "@/components/organizations/jurisdiction-management";
import type { Id } from "@/convex/_generated/dataModel";
export default async function Page({
  params,
}: {
  params: Promise<{ organizationId: string; jurisdictionId: string }>;
}) {
  const p = await params;
  return (
    <JurisdictionSettings
      organizationId={p.organizationId as Id<"organizations">}
      jurisdictionId={p.jurisdictionId as Id<"jurisdictions">}
    />
  );
}
