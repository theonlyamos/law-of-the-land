import Link from "next/link";
import { fetchAuthQuery } from "@/lib/auth-server";
import { organizationApi } from "@/lib/organization-api";
import type { Id } from "@/convex/_generated/dataModel";
export default async function OrganizationLayout({ children, params }: { children: React.ReactNode; params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  const workspace = await fetchAuthQuery(organizationApi.organizations.getWorkspace, { organizationId: organizationId as Id<"organizations"> }).catch(() => null);
  if (!workspace) return <main className="mx-auto max-w-xl space-y-4 p-8"><h1 className="text-2xl font-semibold">Organization access required</h1><p>Sign in with an active organization membership and complete two-factor verification to continue.</p><Link href="/signin" className="underline">Sign in</Link></main>;
  const base = `/organizations/${organizationId}`;
  return <div className="min-h-screen bg-background text-foreground"><header className="border-b px-6 py-5"><Link href="/" className="text-sm text-muted-foreground">Law of the Land</Link><p className="mt-2 text-xl font-semibold">{workspace.organization.name}</p></header><div className="mx-auto grid max-w-7xl gap-8 px-6 py-8 lg:grid-cols-[180px_minmax(0,1fr)]"><nav aria-label="Organization" className="flex gap-4 lg:flex-col">{[["resources", "Documents"], ["settings", "Jurisdiction"], ["website-chat", "Website chat"]].map(([path, label]) => <Link key={path} href={`${base}/${path}`} className="rounded-md px-3 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-2">{label}</Link>)}</nav><main className="min-w-0">{children}</main></div></div>;
}
