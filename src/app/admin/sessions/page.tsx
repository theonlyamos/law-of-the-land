import { api } from "../../../../convex/_generated/api";
import { hasRolePermission } from "../../../../convex/lib/adminPermissions";
import {
  DataTable,
  readAdminTableNavigation,
  type AdminTableSearchParams,
} from "@/components/admin/data-table";
import {
  authorizeAdminPage,
  isAdminAccessDenial,
} from "@/lib/admin/server";
import { fetchAuthQuery } from "@/lib/auth-server";
import Link from "next/link";
import { redirect } from "next/navigation";

const SESSION_COLUMNS = [
  { key: "user", label: "User" },
  { key: "session", label: "Session" },
  { key: "created", label: "Created" },
  { key: "expires", label: "Expires" },
  { key: "kind", label: "Kind" },
  { key: "actions", label: "Actions" },
] as const;

function formatDateTime(timestamp: number) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(timestamp));
}

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<AdminTableSearchParams>;
}) {
  const parameters = await searchParams;
  const navigation = readAdminTableNavigation(parameters);
  const access = await authorizeAdminPage();
  if (
    access.status === "denied" ||
    !hasRolePermission(access.currentAdmin.roles, "session", "revoke")
  ) {
    redirect("/admin/forbidden");
  }

  let result: Awaited<ReturnType<typeof fetchAuthQuery>> | null = null;
  let failed = !navigation.isValid;
  if (!failed) {
    try {
      result = await fetchAuthQuery(api.admin.users.listAllSessions, {
        paginationOpts: { numItems: 30, cursor: navigation.cursor },
      });
    } catch (error) {
      if (isAdminAccessDenial(error)) redirect("/admin/forbidden");
      failed = true;
    }
  }

  const sessions = result && "page" in result
    ? result.page as Array<{
        id: string;
        userId: string;
        userName: string | null;
        userEmail: string | null;
        expiresAt: number;
        createdAt: number;
        updatedAt: number;
        isImpersonated: boolean;
      }>
    : [];

  return (
    <div className="mx-auto max-w-[92rem]">
      <header className="grid gap-5 border-b-2 border-[oklch(35%_0.055_252)] pb-7 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.42fr)] lg:items-end">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[oklch(43%_0.065_67)]">
            People · access history
          </p>
          <h1 className="mt-3 text-[clamp(2.25rem,6vw,4.75rem)] font-semibold leading-[0.96] tracking-[-0.05em] text-[oklch(23%_0.05_252)]">
            Sessions
          </h1>
        </div>
        <p className="max-w-[52ch] text-sm leading-6 text-[oklch(41%_0.035_252)]">
          Review sign-ins across the site. Session credentials, IP addresses,
          and browser fingerprints are never returned to this page.
        </p>
      </header>

      <div className="mt-8">
        <DataTable
          ariaLabel="Site-wide sessions"
          basePath="/admin/sessions"
          columns={SESSION_COLUMNS}
          rows={sessions.map((session) => {
            const userHref = `/admin/users/${encodeURIComponent(session.userId)}`;
            return {
              id: session.id,
              cells: {
                user: (
                  <span className="grid gap-1">
                    <Link
                      href={userHref}
                      className="inline-flex min-h-11 items-center font-semibold text-[oklch(27%_0.06_252)] underline decoration-[oklch(56%_0.11_68)] decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
                    >
                      {session.userName ?? session.userEmail ?? session.userId}
                    </Link>
                    {session.userEmail ? (
                      <span className="break-all text-xs text-[oklch(45%_0.035_252)]">
                        {session.userEmail}
                      </span>
                    ) : null}
                  </span>
                ),
                session: (
                  <span className="break-all text-xs font-semibold">
                    {session.id}
                  </span>
                ),
                created: (
                  <time dateTime={new Date(session.createdAt).toISOString()}>
                    {formatDateTime(session.createdAt)}
                  </time>
                ),
                expires: (
                  <time dateTime={new Date(session.expiresAt).toISOString()}>
                    {formatDateTime(session.expiresAt)}
                  </time>
                ),
                kind: session.isImpersonated ? "Impersonated" : "Direct sign-in",
                actions: session.userId === access.currentAdmin.userId
                  ? "Current administrator"
                  : (
                      <Link
                        href={userHref}
                        className="inline-flex min-h-11 items-center text-sm font-semibold underline decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
                      >
                        Manage sessions
                      </Link>
                    ),
              },
            };
          })}
          currentCursor={navigation.cursor}
          previousCursors={navigation.previousCursors}
          nextCursor={result && "continueCursor" in result ? result.continueCursor as string : ""}
          isDone={result && "isDone" in result ? result.isDone as boolean : true}
          state={failed ? "error" : "ready"}
          emptyMessage="No sessions are available."
          errorMessage="Session records could not be loaded. Clear the pagination state and try again."
        />
      </div>
    </div>
  );
}
