import { redirect } from "next/navigation";
import { fetchAuthQuery } from "@/lib/auth-server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
export default async function Page({params}:{params:Promise<{organizationId:string;resourceId:string}>}) {const {organizationId,resourceId}=await params;const {resource}=await fetchAuthQuery(api.organizationContent.getResource,{organizationId:organizationId as Id<"organizations">,resourceId:resourceId as Id<"legalResources">});redirect(`/organizations/${organizationId}/jurisdictions/${resource.jurisdictionId}/resources/${resourceId}`);}
