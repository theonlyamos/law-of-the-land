import type { Id } from "@/convex/_generated/dataModel";
import { OrganizationDocument } from "@/components/organizations/organization-content";
export default async function Page({ params }: { params: Promise<{ organizationId: string; resourceId: string }> }) { const p = await params; return <OrganizationDocument organizationId={p.organizationId as Id<"organizations">} resourceId={p.resourceId as Id<"legalResources">} />; }
