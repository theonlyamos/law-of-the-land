import { OrganizationSettings } from "@/components/organizations/organization-settings";
import type { Id } from "@/convex/_generated/dataModel";
export default async function Page({ params }: { params: Promise<{ organizationId: string }> }) { return <OrganizationSettings organizationId={(await params).organizationId as Id<"organizations">} />; }
