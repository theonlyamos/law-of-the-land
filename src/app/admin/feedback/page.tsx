import { api } from "../../../../convex/_generated/api";
import { hasRolePermission } from "../../../../convex/lib/adminPermissions";
import { DataTable, readAdminTableNavigation, type AdminTableSearchParams } from "@/components/admin/data-table";
import { authorizeAdminPage } from "@/lib/admin/server";
import { fetchAuthQuery } from "@/lib/auth-server";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  SUPPORT_CATEGORIES,
  SUPPORT_CATEGORY_SHORT_LABELS,
  SUPPORT_STATUSES,
  SUPPORT_STATUS_LABELS,
  type SupportCategory,
  type SupportStatus,
} from "../../../../shared/support";

type TicketRow = {
  id: string;
  category: SupportCategory;
  subject: string;
  status: SupportStatus;
  name?: string;
  email: string;
  signedIn: boolean;
  hasScreenshot: boolean;
  createdAt: number;
};

function exact<T extends readonly string[]>(value: string | string[] | undefined, values: T): T[number] | undefined | null {
  if (value === undefined || value === "") return undefined;
  return Array.isArray(value) || !values.includes(value as never) ? null : (value as T[number]);
}

function formatDateTime(timestamp: number) {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(timestamp));
}

export default async function FeedbackPage({ searchParams }: { searchParams: Promise<AdminTableSearchParams> }) {
  const parameters = await searchParams;
  const navigation = readAdminTableNavigation(parameters);
  const status = exact(parameters.status, SUPPORT_STATUSES);
  const category = exact(parameters.category, SUPPORT_CATEGORIES);
  const access = await authorizeAdminPage();
  if (access.status === "denied" || !hasRolePermission(access.currentAdmin.roles, "user", "read")) redirect("/admin/forbidden");

  let failed = !navigation.isValid || status === null || category === null;
  let result = { page: [] as TicketRow[], isDone: true, continueCursor: "" };
  if (!failed) {
    try {
      result = (await fetchAuthQuery(api.admin.support.listTickets, {
        paginationOpts: { numItems: 30, cursor: navigation.cursor },
        status: status || undefined,
        category: category || undefined,
      })) as typeof result;
    } catch {
      failed = true;
    }
  }

  return (
    <div className="mx-auto max-w-[88rem]">
      <header className="border-b-2 border-slate-700 pb-7">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-800">People · inbox</p>
        <h1 className="mt-3 text-5xl font-semibold tracking-[-0.05em]">Feedback</h1>
        <p className="mt-4 max-w-2xl text-sm leading-6 text-slate-700">
          Questions, bug reports, feature requests and complaints sent through the Contact &amp; feedback form. Newest first.
        </p>
      </header>
      <div className="mt-8">
        <DataTable
          ariaLabel="Feedback messages"
          basePath="/admin/feedback"
          columns={[
            { key: "subject", label: "Message" },
            { key: "category", label: "Category" },
            { key: "status", label: "Status" },
            { key: "from", label: "From" },
            { key: "received", label: "Received (UTC)" },
          ]}
          filters={[
            {
              name: "status",
              label: "Status",
              value: status ?? "",
              options: [{ value: "", label: "All states" }, ...SUPPORT_STATUSES.map((value) => ({ value, label: SUPPORT_STATUS_LABELS[value] }))],
            },
            {
              name: "category",
              label: "Category",
              value: category ?? "",
              options: [{ value: "", label: "All categories" }, ...SUPPORT_CATEGORIES.map((value) => ({ value, label: SUPPORT_CATEGORY_SHORT_LABELS[value] }))],
            },
          ]}
          rows={result.page.map((row) => ({
            id: row.id,
            cells: {
              subject: (
                <Link href={`/admin/feedback/${row.id}`} className="font-semibold underline decoration-[oklch(60%_0.1_70)] decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700">
                  {row.subject}
                </Link>
              ),
              category: SUPPORT_CATEGORY_SHORT_LABELS[row.category],
              status: row.status === "new" ? <span className="font-semibold text-amber-800">{SUPPORT_STATUS_LABELS[row.status]}</span> : SUPPORT_STATUS_LABELS[row.status],
              from: (
                <span className="block max-w-64 truncate" title={row.email}>
                  {row.name ? `${row.name} · ` : ""}{row.email}
                  <span className="block text-xs text-slate-600">{row.signedIn ? "Signed-in user" : "Guest"}{row.hasScreenshot ? " · screenshot" : ""}</span>
                </span>
              ),
              received: formatDateTime(row.createdAt),
            },
          }))}
          currentCursor={navigation.cursor}
          previousCursors={navigation.previousCursors}
          nextCursor={result.continueCursor}
          isDone={result.isDone}
          state={failed ? "error" : "ready"}
          emptyMessage="No messages match these filters yet."
        />
      </div>
    </div>
  );
}
