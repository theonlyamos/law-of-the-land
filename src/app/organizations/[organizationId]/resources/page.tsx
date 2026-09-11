import { redirect } from "next/navigation";
import { fetchAuthQuery } from "@/lib/auth-server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
export default async function Page({params}:{params:Promise<{organizationId:string}>}) { const {organizationId}=await params; const data=await fetchAuthQuery(api.organizations.getWorkspace,{organizationId:organizationId as Id<"organizations">}); redirect(data.jurisdiction ? `/organizations/${organizationId}/jurisdictions/${data.jurisdiction.id}/resources` : `/organizations/${organizationId}/jurisdictions`); }
