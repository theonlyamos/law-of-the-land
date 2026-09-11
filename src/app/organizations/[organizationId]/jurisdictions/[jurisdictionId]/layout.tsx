import Link from "next/link";
import { fetchAuthQuery } from "@/lib/auth-server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
export default async function Layout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ organizationId: string; jurisdictionId: string }>;
}) {
  const { organizationId, jurisdictionId } = await params;
  const data = await fetchAuthQuery(api.organizationJurisdictions.get, {
    organizationId: organizationId as Id<"organizations">,
    jurisdictionId: jurisdictionId as Id<"jurisdictions">,
  }).catch(() => null);
  if (!data)
    return <p>This jurisdiction is unavailable in this organization.</p>;
  const base = `/organizations/${organizationId}/jurisdictions/${jurisdictionId}`;
  return (
    <div className="space-y-7">
      <header>
        <Link
          className="text-sm underline"
          href={`/organizations/${organizationId}/jurisdictions`}
        >
          Jurisdictions
        </Link>
        <p className="mt-3 break-words text-xl font-semibold">
          {data.jurisdiction.name}
        </p>
        <nav
          aria-label="Jurisdiction"
          className="mt-5 flex flex-wrap gap-5 border-b border-[oklch(74%_0.028_78)] pb-3"
        >
          {(data.jurisdiction.status === "archived"
            ? [["settings", "Settings"]]
            : [
                ["resources", "Documents"],
                ["settings", "Settings"],
                ["chat-widget", "Chat widget"],
              ]
          ).map(([path, label]) => (
            <Link
              className="min-h-11 py-3 text-sm font-semibold underline-offset-4 hover:underline"
              key={path}
              href={`${base}/${path}`}
            >
              {label}
            </Link>
          ))}
        </nav>
      </header>
      {children}
    </div>
  );
}
