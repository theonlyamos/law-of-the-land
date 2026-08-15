"use client";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useMutation, usePaginatedQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

type IncidentStatus = "open" | "investigating" | "monitoring" | "resolved";
type IncidentSeverity = "low" | "medium" | "high" | "critical";

export function IncidentCreateForm({ canWrite }: { canWrite: boolean }) {
  const router = useRouter();
  const create = useMutation(api.admin.operations.createIncident);
  const [message, setMessage] = useState("");
  if (!canWrite) return null;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      await create({ title: String(form.get("title")), severity: String(form.get("severity")) as IncidentSeverity, reason: String(form.get("reason")), idempotencyKey: `incident_create_${crypto.randomUUID().replaceAll("-", "")}` });
      formElement.reset();
      setMessage("Incident opened.");
      router.refresh();
    } catch { setMessage("The incident could not be opened."); }
  }
  return (
    <section className="mt-8 border-y border-amber-700 bg-amber-50 px-5 py-6">
      <h2 className="text-2xl font-semibold">Open incident</h2>
      <form onSubmit={submit} className="mt-4 grid gap-3 lg:grid-cols-2">
        <label className="grid gap-2 text-sm font-semibold">Incident title<input name="title" required minLength={3} maxLength={500} className="min-h-11 border px-3" /></label>
        <label className="grid gap-2 text-sm font-semibold">Initial severity<select name="severity" defaultValue="medium" className="min-h-11 border px-3"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option></select></label>
        <label className="grid gap-2 text-sm font-semibold lg:col-span-2">Reason for opening incident<textarea name="reason" required minLength={3} maxLength={500} className="min-h-20 border p-3" /></label>
        <button className="min-h-11 justify-self-start border border-slate-700 px-5 font-semibold">Open incident</button>
        {message ? <p role="status" className="lg:col-span-2">{message}</p> : null}
      </form>
    </section>
  );
}

export function IncidentActions({ incidentId, canWrite, status, severity, ownerId }: { incidentId: Id<"systemIncidents">; canWrite: boolean; status: IncidentStatus; severity: IncidentSeverity; ownerId?: string }) {
  const update = useMutation(api.admin.operations.updateIncident);
  const addNote = useMutation(api.admin.operations.addIncidentNote);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const timeline = usePaginatedQuery(api.admin.operations.listIncidentTimeline, open ? { incidentId } : "skip", { initialNumItems: 20 });

  async function change(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const submittedStatus = String(form.get("status")) as IncidentStatus;
    const submittedSeverity = String(form.get("severity")) as IncidentSeverity;
    const submittedOwner = String(form.get("ownerId") || "") || null;
    const input: { incidentId: Id<"systemIncidents">; status?: IncidentStatus; severity?: IncidentSeverity; ownerId?: string | null; reason: string; idempotencyKey: string } = { incidentId, reason: String(form.get("reason")), idempotencyKey: `incident_${crypto.randomUUID().replaceAll("-", "")}` };
    if (submittedStatus !== status) input.status = submittedStatus;
    if (submittedSeverity !== severity) input.severity = submittedSeverity;
    if (submittedOwner !== (ownerId ?? null)) input.ownerId = submittedOwner;
    if (input.status === undefined && input.severity === undefined && input.ownerId === undefined) {
      setMessage("Choose at least one incident change.");
      return;
    }
    try {
      await update(input);
      setMessage("Incident transition recorded.");
    } catch { setMessage("The incident transition was refused."); }
  }

  async function note(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await addNote({ incidentId, note: String(form.get("note")), reason: String(form.get("reason")), idempotencyKey: `incident_note_${crypto.randomUUID().replaceAll("-", "")}` });
      setMessage("Immutable note appended.");
    } catch { setMessage("The note could not be appended."); }
  }

  return <details onToggle={(event) => setOpen(event.currentTarget.open)}><summary className="min-h-11 cursor-pointer py-3 font-semibold">Timeline and controls</summary>{open ? <div className="grid min-w-72 gap-4"><ol aria-label="Incident timeline" className="border-l-2 border-amber-700 pl-4">{timeline.results.map((item) => <li key={item.id} className="py-2"><span className="font-semibold">{item.kind}</span><span className="block text-xs">{item.summary}</span></li>)}</ol>{timeline.status === "CanLoadMore" ? <button type="button" onClick={() => timeline.loadMore(20)} className="min-h-11 underline">Load older timeline</button> : null}{canWrite ? <><form onSubmit={change} className="grid gap-2"><select aria-label="Incident status" name="status" required defaultValue={status} className="min-h-11 border px-2"><option value="open">Open</option><option value="investigating">Investigating</option><option value="monitoring">Monitoring</option><option value="resolved">Resolved</option></select><select aria-label="Incident severity" name="severity" required defaultValue={severity} className="min-h-11 border px-2"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option></select><input aria-label="Assign owner ID" name="ownerId" defaultValue={ownerId ?? ""} className="min-h-11 border px-2" /><textarea aria-label="Reason for incident transition" name="reason" required minLength={3} maxLength={500} className="min-h-20 border p-2" /><button className="min-h-11 border border-slate-700 font-semibold">Record transition</button></form><form onSubmit={note} className="grid gap-2"><textarea aria-label="Immutable incident note" name="note" required minLength={3} maxLength={500} className="min-h-20 border p-2" /><textarea aria-label="Reason for incident note" name="reason" required minLength={3} maxLength={500} className="min-h-20 border p-2" /><button className="min-h-11 border border-slate-700 font-semibold">Append note</button></form></> : null}{message ? <p role="status">{message}</p> : null}</div> : null}</details>;
}
