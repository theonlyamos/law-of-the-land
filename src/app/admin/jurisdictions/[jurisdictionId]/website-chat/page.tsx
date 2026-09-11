import { notFound, redirect } from "next/navigation";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { hasRolePermission } from "@/convex/lib/adminPermissions";
import { authorizeAdminPage } from "@/lib/admin/server";
import { fetchAuthQuery } from "@/lib/auth-server";
import { WebsiteChatSettings } from "@/components/organizations/website-chat-settings";

export default async function GeographicWebsiteChatPage({ params }: { params: Promise<{ jurisdictionId: string }> }) {
  const access = await authorizeAdminPage();
  if (access.status === "denied" || (!hasRolePermission(access.currentAdmin.roles, "jurisdiction", "read") && !hasRolePermission(access.currentAdmin.roles, "jurisdiction", "write"))) redirect("/admin/forbidden");
  const { jurisdictionId } = await params;
  try { await fetchAuthQuery(api.widgets.getSettings, { jurisdictionId: jurisdictionId as Id<"jurisdictions"> }); }
  catch { notFound(); }
  return <WebsiteChatSettings jurisdictionId={jurisdictionId as Id<"jurisdictions">} />;
}
