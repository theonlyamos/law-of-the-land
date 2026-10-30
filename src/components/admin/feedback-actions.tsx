"use client";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { SUPPORT_LIMITS, SUPPORT_STATUSES, SUPPORT_STATUS_LABELS, type SupportStatus } from "../../../shared/support";

export function FeedbackActions({ ticketId, status }: { ticketId: Id<"supportTickets">; status: SupportStatus }) {
  const router = useRouter();
  const updateStatus = useMutation(api.admin.support.updateTicketStatus);
  const addNote = useMutation(api.admin.support.addTicketNote);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function changeStatus(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = String(new FormData(event.currentTarget).get("status")) as SupportStatus;
    if (next === status) {
      setMessage("Choose a different status.");
      return;
    }
    setBusy(true);
    try {
      await updateStatus({ ticketId, status: next });
      setMessage(`Marked as ${SUPPORT_STATUS_LABELS[next].toLowerCase()}.`);
      router.refresh();
    } catch {
      setMessage("The status could not be changed.");
    } finally {
      setBusy(false);
    }
  }

  async function note(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = String(new FormData(form).get("note") ?? "");
    setBusy(true);
    try {
      await addNote({ ticketId, body });
      form.reset();
      setMessage("Note added.");
      router.refresh();
    } catch {
      setMessage("The note could not be added.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8 grid gap-6 border-y border-amber-700 bg-amber-50 px-5 py-6 lg:grid-cols-2">
      <form onSubmit={(event) => void changeStatus(event)} className="grid content-start gap-3">
        <h2 className="text-xl font-semibold">Status</h2>
        <label className="grid gap-2 text-sm font-semibold">
          Change status
          <select name="status" defaultValue={status} className="min-h-11 border bg-white px-3">
            {SUPPORT_STATUSES.map((value) => <option key={value} value={value}>{SUPPORT_STATUS_LABELS[value]}</option>)}
          </select>
        </label>
        <button disabled={busy} className="min-h-11 justify-self-start border border-slate-700 px-5 font-semibold disabled:opacity-60">Save status</button>
      </form>
      <form onSubmit={(event) => void note(event)} className="grid content-start gap-3">
        <h2 className="text-xl font-semibold">Internal note</h2>
        <label className="grid gap-2 text-sm font-semibold">
          Only administrators can see notes
          <textarea name="note" required minLength={1} maxLength={SUPPORT_LIMITS.noteMax} className="min-h-24 border bg-white p-3 font-normal" />
        </label>
        <button disabled={busy} className="min-h-11 justify-self-start border border-slate-700 px-5 font-semibold disabled:opacity-60">Add note</button>
      </form>
      {message ? <p role="status" className="text-sm lg:col-span-2">{message}</p> : null}
    </section>
  );
}
