import Link from "next/link";
import { fetchAuthQuery } from "@/lib/auth-server";
import { organizationApi } from "@/lib/organization-api";
export default async function Page() {
  const organizations = await fetchAuthQuery(organizationApi.organizations.listMine, {}).catch(() => null);
  return <main className="mx-auto w-full max-w-3xl space-y-6 p-8"><h1 className="text-3xl font-semibold">Your organizations</h1>{organizations ? organizations.length ? <ul className="divide-y rounded-lg border">{organizations.map(org => <li key={org.id} className="p-4"><Link href={`/organizations/${org.id}`} className="font-medium underline">{org.name}</Link><p className="text-sm text-muted-foreground">{org.role}</p></li>)}</ul> : <p>You don't have an active organization membership. Contact your platform administrator for access.</p> : <p>Complete <Link href="/settings/security" className="underline">two-factor verification</Link> to access your organizations.</p>}</main>;
}
