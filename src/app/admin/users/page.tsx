import { api } from "../../../../convex/_generated/api";
import { hasRolePermission } from "../../../../convex/lib/adminPermissions";
import {
  DataTable,
  readAdminTableNavigation,
  type AdminTableSearchParams,
} from "@/components/admin/data-table";
import { authorizeAdminPage } from "@/lib/admin/server";
import { fetchAuthQuery } from "@/lib/auth-server";
import Link from "next/link";
import { redirect } from "next/navigation";

const USER_COLUMNS = [
  { key: "identity", label: "User" },
  { key: "authority", label: "Authority" },
  { key: "assurance", label: "Assurance" },
  { key: "status", label: "Status" },
  { key: "created", label: "Created" },
] as const;

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(timestamp));
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<AdminTableSearchParams>;
}) {
  const parameters = await searchParams;
  const navigation = readAdminTableNavigation(parameters);
  const by = single(parameters.by) ?? "email";
  const q = single(parameters.q) ?? "";
  const filterIsValid = by === "email" || by === "user_id";
  const access = await authorizeAdminPage();
  if (
    access.status === "denied" ||
    !hasRolePermission(access.currentAdmin.roles, "user", "read")
  ) {
    redirect("/admin/forbidden");
  }

  let result: Awaited<ReturnType<typeof fetchAuthQuery>> | null = null;
  let failed = !navigation.isValid || !filterIsValid;
  if (!failed) {
    try {
      result = await fetchAuthQuery(api.admin.users.list, {
        paginationOpts: { numItems: 30, cursor: navigation.cursor },
        ...(q
          ? {
              search: {
                kind: by === "user_id" ? "user_id" : "email",
                value: q,
              },
            }
          : {}),
      });
    } catch {
      failed = true;
    }
  }

  const users =
    result && "page" in result
      ? result.page as Array<{
          id: string;
          name: string;
          email: string;
          emailVerified: boolean;
          createdAt: number;
          roles: string[];
          banned: boolean;
          twoFactorEnabled: boolean;
        }>
      : [];

  return (
    <div className="mx-auto max-w-[88rem]">
      <header className="grid gap-5 border-b-2 border-[oklch(35%_0.055_252)] pb-7 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.42fr)] lg:items-end">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[oklch(43%_0.065_67)]">
            People · exact directory
          </p>
          <h1 className="mt-3 text-[clamp(2.25rem,6vw,4.75rem)] font-semibold leading-[0.96] tracking-[-0.05em] text-[oklch(23%_0.05_252)]">
            Users
          </h1>
        </div>
        <p className="max-w-[48ch] text-sm leading-6 text-[oklch(41%_0.035_252)]">
          Search by a complete email address or Better Auth user ID. Results
          are intentionally limited to operational identity fields.
        </p>
      </header>

      <div className="mt-8">
        <DataTable
          ariaLabel="Users"
          basePath="/admin/users"
          columns={USER_COLUMNS}
          rows={users.map((user) => ({
            id: user.id,
            cells: {
              identity: (
                <span className="grid gap-1">
                  <Link
                    href={`/admin/users/${encodeURIComponent(user.id)}`}
                    className="font-semibold text-[oklch(27%_0.06_252)] underline decoration-[oklch(56%_0.11_68)] decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
                  >
                    {user.name}
                  </Link>
                  <span className="break-all text-xs text-[oklch(45%_0.035_252)]">
                    {user.email}
                  </span>
                </span>
              ),
              authority: user.roles.length > 0
                ? user.roles.join(", ").replaceAll("_", " ")
                : "Public user",
              assurance: user.twoFactorEnabled
                ? "Two-factor enrolled"
                : user.emailVerified
                  ? "Email verified"
                  : "Email pending",
              status: user.banned ? "Suspended" : "Active",
              created: (
                <time dateTime={new Date(user.createdAt).toISOString()}>
                  {formatDate(user.createdAt)}
                </time>
              ),
            },
          }))}
          filters={[
            {
              name: "by",
              label: "Lookup field",
              value: by,
              options: [
                { value: "email", label: "Email address" },
                { value: "user_id", label: "User ID" },
              ],
            },
            {
              name: "q",
              label: "Exact value",
              value: q,
              placeholder:
                by === "email" ? "name@example.com" : "Better Auth user ID",
            },
          ]}
          currentCursor={navigation.cursor}
          previousCursors={navigation.previousCursors}
          nextCursor={
            result && "continueCursor" in result
              ? result.continueCursor as string
              : ""
          }
          isDone={
            result && "isDone" in result ? result.isDone as boolean : true
          }
          state={failed ? "error" : "ready"}
          emptyMessage="No users match this exact lookup."
          errorMessage="User records could not be loaded. Check the exact lookup and pagination link, then try again."
        />
      </div>
    </div>
  );
}
