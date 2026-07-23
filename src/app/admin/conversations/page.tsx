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

const CONVERSATION_COLUMNS = [
  { key: "conversation", label: "Conversation" },
  { key: "owner", label: "Owner" },
  { key: "jurisdiction", label: "Jurisdiction" },
  { key: "messages", label: "Messages", align: "end" as const },
  { key: "updated", label: "Updated" },
] as const;

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function formatDateTime(timestamp: number) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(timestamp));
}

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<AdminTableSearchParams>;
}) {
  const parameters = await searchParams;
  const navigation = readAdminTableNavigation(parameters);
  const userId = single(parameters.userId) ?? "";
  const access = await authorizeAdminPage();
  if (
    access.status === "denied" ||
    !hasRolePermission(
      access.currentAdmin.roles,
      "conversation",
      "read_content",
    )
  ) {
    redirect("/admin/forbidden");
  }

  let result: Awaited<ReturnType<typeof fetchAuthQuery>> | null = null;
  let failed = !navigation.isValid || Array.isArray(parameters.userId);
  if (!failed) {
    try {
      result = await fetchAuthQuery(api.admin.conversations.list, {
        paginationOpts: { numItems: 30, cursor: navigation.cursor },
        ...(userId ? { userId } : {}),
      });
    } catch {
      failed = true;
    }
  }

  const conversations =
    result && "page" in result
      ? result.page as Array<{
          id: string;
          userId: string;
          externalId: string;
          messageCount: number;
          updatedAt: number;
          country: string | null;
        }>
      : [];

  return (
    <div className="mx-auto max-w-[88rem]">
      <header className="grid gap-5 border-b-2 border-[oklch(35%_0.055_252)] pb-7 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.42fr)] lg:items-end">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[oklch(43%_0.065_67)]">
            Support · metadata register
          </p>
          <h1 className="mt-3 text-[clamp(2.25rem,6vw,4.75rem)] font-semibold leading-[0.96] tracking-[-0.05em] text-[oklch(23%_0.05_252)]">
            Conversations
          </h1>
        </div>
        <p className="max-w-[48ch] text-sm leading-6 text-[oklch(41%_0.035_252)]">
          This register contains identifiers, jurisdiction, counts, and timing
          only. Prompts, answers, attachments, and exports are excluded.
        </p>
      </header>

      <div className="mt-8">
        <DataTable
          ariaLabel="Conversations"
          basePath="/admin/conversations"
          columns={CONVERSATION_COLUMNS}
          rows={conversations.map((conversation) => ({
            id: conversation.id,
            cells: {
              conversation: (
                <span className="grid gap-1">
                  <span className="font-semibold text-[oklch(27%_0.06_252)]">
                    {conversation.id}
                  </span>
                  <span className="break-all text-xs text-[oklch(45%_0.035_252)]">
                    {conversation.externalId}
                  </span>
                </span>
              ),
              owner: (
                <Link
                  href={`/admin/users/${encodeURIComponent(conversation.userId)}`}
                  className="break-all font-semibold underline decoration-[oklch(56%_0.11_68)] decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
                >
                  {conversation.userId}
                </Link>
              ),
              jurisdiction: conversation.country ?? "Default jurisdiction",
              messages: (
                <span className="tabular-nums">
                  {conversation.messageCount.toLocaleString("en")}
                </span>
              ),
              updated: (
                <time dateTime={new Date(conversation.updatedAt).toISOString()}>
                  {formatDateTime(conversation.updatedAt)}
                </time>
              ),
            },
          }))}
          filters={[
            {
              name: "userId",
              label: "Exact owner ID",
              value: userId,
              placeholder: "Better Auth user ID",
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
          emptyMessage="No conversation metadata matches this owner."
          errorMessage="Conversation records could not be loaded. Check the filter and pagination link, then try again."
        />
      </div>
    </div>
  );
}
