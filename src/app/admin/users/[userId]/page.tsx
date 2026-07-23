import { api } from "../../../../../convex/_generated/api";
import { hasRolePermission } from "../../../../../convex/lib/adminPermissions";
import {
  DataTable,
  readAdminTableNavigation,
  type AdminTableSearchParams,
} from "@/components/admin/data-table";
import { authorizeAdminPage } from "@/lib/admin/server";
import { fetchAuthQuery } from "@/lib/auth-server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

const SESSION_COLUMNS = [
  { key: "session", label: "Session" },
  { key: "created", label: "Created" },
  { key: "expires", label: "Expires" },
  { key: "kind", label: "Kind" },
] as const;

function formatDateTime(timestamp: number) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(timestamp));
}

export default async function UserDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ userId: string }>;
  searchParams: Promise<AdminTableSearchParams>;
}) {
  const [{ userId }, parameters] = await Promise.all([params, searchParams]);
  const navigation = readAdminTableNavigation(parameters);
  const access = await authorizeAdminPage();
  if (
    access.status === "denied" ||
    !hasRolePermission(access.currentAdmin.roles, "user", "read")
  ) {
    redirect("/admin/forbidden");
  }

  let userResult: Awaited<ReturnType<typeof fetchAuthQuery>>;
  try {
    userResult = await fetchAuthQuery(api.admin.users.list, {
      paginationOpts: { numItems: 1, cursor: null },
      search: { kind: "user_id", value: userId },
    });
  } catch {
    redirect("/admin/forbidden");
  }
  const users = userResult.page as Array<{
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    createdAt: number;
    updatedAt: number;
    roles: string[];
    banned: boolean;
    twoFactorEnabled: boolean;
  }>;
  const user = users[0];
  if (!user) {
    notFound();
  }

  const canReadSessions = hasRolePermission(
    access.currentAdmin.roles,
    "session",
    "revoke",
  );
  let sessionResult: Awaited<ReturnType<typeof fetchAuthQuery>> | null = null;
  let sessionsFailed = !navigation.isValid;
  if (canReadSessions && !sessionsFailed) {
    try {
      sessionResult = await fetchAuthQuery(api.admin.users.listSessions, {
        userId,
        paginationOpts: { numItems: 20, cursor: navigation.cursor },
      });
    } catch {
      sessionsFailed = true;
    }
  }
  const sessions =
    sessionResult && "page" in sessionResult
      ? sessionResult.page as Array<{
          id: string;
          userId: string;
          expiresAt: number;
          createdAt: number;
          updatedAt: number;
          isImpersonated: boolean;
        }>
      : [];

  return (
    <div className="mx-auto max-w-[82rem]">
      <Link
        href="/admin/users"
        className="inline-flex min-h-11 items-center text-sm font-semibold underline decoration-[oklch(56%_0.11_68)] decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
      >
        Back to users
      </Link>
      <header className="mt-5 grid gap-7 border-b-2 border-[oklch(35%_0.055_252)] pb-8 lg:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.65fr)]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[oklch(43%_0.065_67)]">
            User record
          </p>
          <h1 className="mt-3 break-words text-[clamp(2rem,5vw,4.25rem)] font-semibold leading-[0.98] tracking-[-0.05em] text-[oklch(23%_0.05_252)]">
            {user.name}
          </h1>
          <p className="mt-4 break-all text-base text-[oklch(39%_0.04_252)]">
            {user.email}
          </p>
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] content-start gap-x-5 gap-y-3 border-l border-[oklch(69%_0.035_78)] pl-5 text-sm">
          <dt className="font-semibold">Status</dt>
          <dd>{user.banned ? "Suspended" : "Active"}</dd>
          <dt className="font-semibold">Authority</dt>
          <dd>
            {user.roles.length > 0
              ? user.roles.join(", ").replaceAll("_", " ")
              : "Public user"}
          </dd>
          <dt className="font-semibold">Email</dt>
          <dd>{user.emailVerified ? "Verified" : "Pending"}</dd>
          <dt className="font-semibold">Two-factor</dt>
          <dd>{user.twoFactorEnabled ? "Enrolled" : "Not enrolled"}</dd>
          <dt className="font-semibold">User ID</dt>
          <dd className="break-all text-xs">{user.id}</dd>
        </dl>
      </header>

      <section className="mt-10" aria-labelledby="user-sessions-heading">
        <div className="mb-5 border-b border-[oklch(69%_0.035_78)] pb-3">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[oklch(47%_0.04_252)]">
            Assured access
          </p>
          <h2
            id="user-sessions-heading"
            className="mt-1 text-2xl font-semibold tracking-[-0.035em]"
          >
            Sessions
          </h2>
        </div>
        {canReadSessions ? (
          <DataTable
            ariaLabel="User sessions"
            basePath={`/admin/users/${encodeURIComponent(userId)}`}
            columns={SESSION_COLUMNS}
            rows={sessions.map((session) => ({
              id: session.id,
              cells: {
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
                kind: session.isImpersonated
                  ? "Impersonated"
                  : "Direct sign-in",
              },
            }))}
            currentCursor={navigation.cursor}
            previousCursors={navigation.previousCursors}
            nextCursor={
              sessionResult && "continueCursor" in sessionResult
                ? sessionResult.continueCursor as string
                : ""
            }
            isDone={
              sessionResult && "isDone" in sessionResult
                ? sessionResult.isDone as boolean
                : true
            }
            state={sessionsFailed ? "error" : "ready"}
            emptyMessage="No active or historical sessions are available for this user."
            errorMessage="Session records could not be loaded. Clear the pagination state and try again."
          />
        ) : (
          <p className="border-y border-[oklch(74%_0.028_78)] bg-[oklch(96%_0.014_82)] px-5 py-8 text-sm leading-6 text-[oklch(36%_0.04_252)]">
            Session records are not included in your role.
          </p>
        )}
      </section>
    </div>
  );
}
