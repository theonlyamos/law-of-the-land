import type { Id } from "@/convex/_generated/dataModel";
import { OrganizationResources } from "@/components/organizations/organization-content";
export default async function Page({ params }: { params: Promise<{ organizationId: string }> }) { return <OrganizationResources organizationId={(await params).organizationId as Id<"organizations">} />; }
