import { AdminShell } from "@/components/admin/admin-shell";
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
    return children;
  }

  let currentAdmin;
  try {
    currentAdmin = await authorizeAdminPage();
  } catch {
    redirect("/admin/forbidden");
  }

  return (
    <AdminShell currentAdmin={currentAdmin} currentPath={pathname ?? undefined}>
      {children}
    </AdminShell>
  );
}
