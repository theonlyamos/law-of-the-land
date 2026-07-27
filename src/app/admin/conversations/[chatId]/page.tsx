import type { Id } from "../../../../../convex/_generated/dataModel";
import { hasRolePermission } from "../../../../../convex/lib/adminPermissions";
import { ConversationViewer } from "@/components/admin/conversation-viewer";
import { authorizeAdminPage } from "@/lib/admin/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export default async function ConversationDetailPage({
  params,
}: {
  params: Promise<{ chatId: string }>;
}) {
  const { chatId } = await params;
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

  return (
    <div className="mx-auto max-w-[82rem]">
      <Link
        href="/admin/conversations"
        className="inline-flex min-h-11 items-center text-sm font-semibold underline decoration-[oklch(56%_0.11_68)] decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
      >
        Back to conversations
      </Link>
      <header className="mt-5 grid gap-6 border-b-2 border-[oklch(35%_0.055_252)] pb-8 lg:grid-cols-[minmax(0,1fr)_minmax(17rem,0.42fr)] lg:items-end">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[oklch(43%_0.065_67)]">
            Support · restricted record
          </p>
          <h1 className="mt-3 text-[clamp(2.15rem,5vw,4.35rem)] font-semibold leading-[0.98] tracking-[-0.05em] text-[oklch(23%_0.05_252)]">
            Conversation record
          </h1>
        </div>
        <dl className="grid gap-1 border-l border-[oklch(69%_0.035_78)] pl-5 text-sm">
          <dt className="font-semibold">Conversation ID</dt>
          <dd className="break-all text-xs text-[oklch(42%_0.035_252)]">{chatId}</dd>
        </dl>
      </header>

      <ConversationViewer chatId={chatId as Id<"chatSessions">} />
    </div>
  );
}
