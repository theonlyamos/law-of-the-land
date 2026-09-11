import Link from "next/link";
import { fetchAuthQuery } from "@/lib/auth-server";
import { organizationApi } from "@/lib/organization-api";
import type { Id } from "@/convex/_generated/dataModel";
import { OrganizationShell } from "@/components/organizations/organization-shell";
export default async function OrganizationLayout({ children, params }: { children: React.ReactNode; params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  const workspace = await fetchAuthQuery(organizationApi.organizations.getOrganizationWorkspace, { organizationId: organizationId as Id<"organizations"> }).catch(() => null);
  if (!workspace) return <main className="mx-auto max-w-xl space-y-4 p-8"><h1 className="text-2xl font-semibold">Organization access required</h1><p>Sign in with an active organization membership and complete two-factor verification to continue.</p><Link href="/settings/security" className="underline">Account security</Link><Link href="/organizations" className="block underline">Your organizations</Link></main>;
  return <OrganizationShell organizationId={organizationId} name={workspace.organization.name} archived={workspace.organization.status === "archived"}>{children}</OrganizationShell>;
}
