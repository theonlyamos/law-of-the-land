import type { Id } from "@/convex/_generated/dataModel";
import { OrganizationSettings } from "@/components/organizations/organization-content";
export default async function Page({ params }: { params: Promise<{ organizationId: string }> }) { return <OrganizationSettings organizationId={(await params).organizationId as Id<"organizations">} />; }
