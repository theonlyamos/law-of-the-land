import { AdminShell } from "@/components/admin/admin-shell";
import { AdminAuthBoundary } from "@/components/admin/admin-auth-boundary";
import { AccountProviders } from "@/components/providers/account-providers";
import { authorizeAdminPage } from "@/lib/admin/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export default async function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const pathname = (await headers()).get("x-admin-pathname");

  // This destination contains no privileged data. Exempting it prevents the
  // denied-session redirect from re-entering the guarded layout indefinitely.
  if (pathname === "/admin/forbidden") {
    return <AccountProviders>{children}</AccountProviders>;
  }

  const access = await authorizeAdminPage();
  if (access.status === "denied") {
    redirect("/admin/forbidden");
  }

  return (
    <AccountProviders><AdminShell currentAdmin={access.currentAdmin} currentPath={pathname ?? undefined}>
      <AdminAuthBoundary>{children}</AdminAuthBoundary>
    </AdminShell></AccountProviders>
  );
}
