import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { hasRolePermission } from "../../../../../convex/lib/adminPermissions";
import { FeedbackActions } from "@/components/admin/feedback-actions";
import { authorizeAdminPage } from "@/lib/admin/server";
import { fetchAuthQuery } from "@/lib/auth-server";
import type { FunctionReturnType } from "convex/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { SUPPORT_CATEGORY_SHORT_LABELS, SUPPORT_STATUS_LABELS, supportReference } from "../../../../../shared/support";

type TicketDetail = NonNullable<FunctionReturnType<typeof api.admin.support.getTicket>>;

function formatDateTime(timestamp: number) {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(timestamp));
}

const backLink = "inline-flex min-h-11 items-center text-sm font-semibold underline decoration-[oklch(56%_0.11_68)] decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700";

export default async function FeedbackDetailPage({ params }: { params: Promise<{ ticketId: string }> }) {
  const { ticketId } = await params;
  const access = await authorizeAdminPage();
  if (access.status === "denied" || !hasRolePermission(access.currentAdmin.roles, "user", "read")) redirect("/admin/forbidden");
  const canWrite = hasRolePermission(access.currentAdmin.roles, "user", "support");
  if (!/^[a-z0-9]{20,64}$/.test(ticketId)) notFound();

  let detail: TicketDetail | null = null;
  let failed = false;
  try {
    detail = await fetchAuthQuery(api.admin.support.getTicket, { ticketId: ticketId as Id<"supportTickets"> });
  } catch {
    failed = true;
  }
  if (!failed && !detail) notFound();

  if (failed || !detail) {
    return (
      <div className="mx-auto max-w-[72rem]">
        <Link href="/admin/feedback" className={backLink}>Back to feedback</Link>
        <div role="alert" className="mt-7 border-y border-[oklch(67%_0.055_35)] bg-[oklch(93%_0.035_45)] px-5 py-8 sm:px-7">
          <h1 className="text-2xl font-semibold tracking-[-0.035em]">This message could not be loaded</h1>
          <p className="mt-3 max-w-[62ch] text-sm leading-6">Check the connection and try again.</p>
        </div>
      </div>
    );
  }

  const { ticket, notes } = detail;
  const replySubject = encodeURIComponent(`Re: ${ticket.subject} (#${supportReference(ticket.id)})`);

  return (
    <div className="mx-auto max-w-[72rem]">
      <Link href="/admin/feedback" className={backLink}>Back to feedback</Link>
      <header className="mt-4 border-b-2 border-slate-700 pb-7">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-800">
          {SUPPORT_CATEGORY_SHORT_LABELS[ticket.category]} · #{supportReference(ticket.id)} · {SUPPORT_STATUS_LABELS[ticket.status]}
        </p>
        <h1 className="mt-3 break-words text-4xl font-semibold tracking-[-0.04em]">{ticket.subject}</h1>
        <p className="mt-3 text-sm text-slate-700">Received {formatDateTime(ticket.createdAt)} UTC</p>
      </header>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <article className="min-w-0">
          <h2 className="sr-only">Message</h2>
          <p className="whitespace-pre-wrap break-words text-base leading-7">{ticket.message}</p>
          {ticket.screenshotUrl ? (
            <figure className="mt-6">
              <a href={ticket.screenshotUrl} target="_blank" rel="noopener noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element -- signed storage URL */}
                <img src={ticket.screenshotUrl} alt="Screenshot attached by the sender" className="max-h-[32rem] max-w-full border border-slate-300" />
              </a>
              <figcaption className="mt-2 text-xs text-slate-600">Screenshot attached by the sender. Select it to open full size.</figcaption>
            </figure>
          ) : null}
        </article>

        <aside className="grid content-start gap-4 border-l-2 border-amber-700 pl-5 text-sm">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-600">From</p>
            <p className="mt-1 font-semibold">{ticket.name ?? "No name given"}</p>
            <p className="break-all">{ticket.email}</p>
            <p className="text-slate-600">{ticket.signedIn ? "Signed-in user" : "Guest (email not verified)"}</p>
            {ticket.userId ? <Link href={`/admin/users/${encodeURIComponent(ticket.userId)}`} className="mt-1 inline-block underline underline-offset-4">View user record</Link> : null}
          </div>
          <a href={`mailto:${ticket.email}?subject=${replySubject}`} className="inline-flex min-h-11 items-center justify-center bg-[oklch(28%_0.055_252)] px-5 font-semibold text-[oklch(97%_0.012_82)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700">
            Reply by email
          </a>
          {ticket.pagePath ? (
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-600">Sent from page</p>
              <p className="mt-1 break-all font-mono text-xs">{ticket.pagePath}</p>
            </div>
          ) : null}
          {ticket.userAgent ? (
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-600">Browser</p>
              <p className="mt-1 break-words font-mono text-xs">{ticket.userAgent}</p>
            </div>
          ) : null}
        </aside>
      </div>

      {canWrite ? <FeedbackActions ticketId={ticket.id} status={ticket.status} /> : null}

      <section className="mt-8">
        <h2 className="text-xl font-semibold">History</h2>
        {notes.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">No notes or status changes yet.</p>
        ) : (
          <ol aria-label="Message history" className="mt-3 border-l-2 border-amber-700 pl-4">
            {notes.map((note) => (
              <li key={note.id} className="py-2">
                <span className="text-xs text-slate-600">{formatDateTime(note.createdAt)} UTC · {note.kind === "status" ? "Status" : "Note"}</span>
                <span className="block whitespace-pre-wrap break-words text-sm">{note.body}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
