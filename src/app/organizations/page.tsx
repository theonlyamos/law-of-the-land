import { Suspense } from "react";
import { OrganizationShell } from "@/components/organizations/organization-shell";
import { OrganizationManagement } from "@/components/organizations/organization-management";
export default function Page() { return <OrganizationShell><Suspense fallback={<p role="status">Loading organizations…</p>}><OrganizationManagement /></Suspense></OrganizationShell>; }
