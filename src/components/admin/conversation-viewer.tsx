"use client";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import {
  useEffect,
  useState,
  type FormEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import { PermissionBoundary } from "./permission-boundary";

type AccessGrant = {
  grantId: Id<"adminAccessGrants">;
  expiresAt: number;
};
type DownloadReference = { reference: string; expiresAt: number };

function newExportKey(): string {
  return `export_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function safeMarkdownUrl(url: string): string {
  try {
    const parsed = new URL(url, "https://admin.invalid");
    return parsed.protocol === "http:" ||
      parsed.protocol === "https:" ||
      parsed.protocol === "mailto:"
      ? url
      : "";
  } catch {
    return "";
  }
}

function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(timestamp));
}

export function ConversationViewer({
  chatId,
}: {
  chatId: Id<"chatSessions">;
}) {
  const createGrant = useMutation(api.admin.conversations.createAccessGrant);
  const queueExport = useMutation(api.admin.exports.queueConversationExport);
  const issueExportReference = useMutation(api.admin.exports.issueConversationExportReference);
  const [grant, setGrant] = useState<AccessGrant | null>(null);
  const [accessState, setAccessState] = useState<"idle" | "working" | "error">("idle");
  const [accessError, setAccessError] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportKey, setExportKey] = useState("");
  const [exportState, setExportState] = useState<"idle" | "working" | "queued" | "error">("idle");
  const [exportError, setExportError] = useState("");
  const [exportCorrelationId, setExportCorrelationId] = useState<string | null>(null);
  const [downloadReference, setDownloadReference] = useState<DownloadReference | null>(null);
  const [downloadWorking, setDownloadWorking] = useState(false);
  const exportStatus = useQuery(api.admin.exports.getConversationExportStatus, exportCorrelationId && grant ? { correlationId: exportCorrelationId, grantId: grant.grantId } : "skip");
  const {
    results: messages,
    status: messagesStatus,
    loadMore,
  } = usePaginatedQuery(
    api.admin.conversations.listMessages,
    grant ? { chatId, grantId: grant.grantId } : "skip",
    { initialNumItems: 50 },
  );

  async function requestAccess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (accessState === "working") return;
    const purpose = String(new FormData(event.currentTarget).get("purpose") ?? "").trim();
    setAccessState("working");
    setAccessError("");
    try {
      const result = await createGrant({ chatId, purpose });
      setGrant(result);
      setAccessState("idle");
    } catch (error) {
      setAccessState("error");
      setAccessError(
        error instanceof Error
          ? error.message
          : "Conversation access could not be granted.",
      );
    }
  }

  function prepareExport() {
    setExportKey(newExportKey());
    setExportState("idle");
    setExportError("");
    setDownloadReference(null);
    setExportOpen(true);
  }

  async function submitExport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!grant || exportState === "working") return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const reason = String(form.get("reason") ?? "").trim();
    const confirmation = String(form.get("confirmation") ?? "");
    const password = String(form.get("password") ?? "");
    setExportState("working");
    setExportError("");
    try {
      const verification = await fetch("/api/auth/verify-password", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-admin-step-up-action": "conversation_export",
          "x-admin-step-up-target": `${chatId}:${grant.grantId}`,
          "x-admin-step-up-key": exportKey,
        },
        body: JSON.stringify({ password }),
      });
      const passwordInput = formElement.elements.namedItem("password");
      if (passwordInput instanceof HTMLInputElement) {
        passwordInput.value = "";
      }
      if (!verification.ok) {
        throw new Error(
          "Your password could not be verified. Check it and try again.",
        );
      }
      const queued = await queueExport({
        chatId,
        grantId: grant.grantId,
        reason,
        idempotencyKey: exportKey,
        confirmation,
      });
      setExportCorrelationId(queued.correlationId);
      setDownloadReference(null);
      setExportState("queued");
    } catch (error) {
      setExportState("error");
      setExportError(
        error instanceof Error
          ? error.message
          : "The export could not be queued.",
      );
    }
  }

  async function downloadExport() {
    if (!grant || !exportCorrelationId || downloadWorking) return;
    setDownloadWorking(true);
    setExportError("");
    try {
      let issued = downloadReference;
      if (!issued || issued.expiresAt <= Date.now()) {
        setDownloadReference(null);
        issued = await issueExportReference({ correlationId: exportCorrelationId, grantId: grant.grantId });
        setDownloadReference(issued);
      }
      const response = await fetch("/api/admin/exports/download", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ reference: issued.reference }) });
      if (!response.ok) {
        if (response.status === 404) setDownloadReference(null);
        throw new Error(response.status === 404 ? "The one-time export reference expired or was already used." : "The export service is temporarily unavailable. Retry this one-time download.");
      }
      setDownloadReference(null);
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = "conversation-export.ndjson"; anchor.click(); URL.revokeObjectURL(url);
    } catch (error) { setExportError(error instanceof Error ? error.message : "The export could not be downloaded."); }
    finally { setDownloadWorking(false); }
  }

  useEffect(() => {
    if (!downloadReference) return;
    const reference = downloadReference.reference;
    const timer = window.setTimeout(() => setDownloadReference((current) => current?.reference === reference ? null : current), Math.min(2_147_483_647, Math.max(0, downloadReference.expiresAt - Date.now())));
    return () => window.clearTimeout(timer);
  }, [downloadReference]);

  const fieldClass =
    "min-h-11 border border-[oklch(61%_0.035_252)] bg-[oklch(99%_0.007_82)] px-3 py-2 font-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700";

  if (!grant) {
    return (
      <section aria-labelledby="conversation-access-heading" className="mt-8 grid gap-7 border-y border-[oklch(72%_0.03_78)] bg-[oklch(97%_0.012_82)] px-5 py-8 lg:grid-cols-[minmax(0,0.72fr)_minmax(20rem,1fr)] lg:px-8">
        <header>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[oklch(45%_0.06_65)]">
            Protected transcript
          </p>
          <h2 id="conversation-access-heading" className="mt-2 text-2xl font-semibold tracking-[-0.035em]">
            State your purpose before access
          </h2>
          <p className="mt-3 max-w-[52ch] text-sm leading-6 text-[oklch(39%_0.035_252)]">
            Opening message content creates one auditable grant. It expires after 15 minutes and is bound to this conversation and your administrator account.
          </p>
        </header>
        <form onSubmit={requestAccess} className="grid content-start gap-4">
          <label className="grid gap-2 text-sm font-semibold">
            Purpose for access
            <textarea
              name="purpose"
              required
              minLength={3}
              maxLength={500}
              rows={4}
              className={`${fieldClass} min-h-28 resize-y`}
            />
          </label>
          {accessState === "error" ? (
            <p role="alert" className="border-y border-[oklch(62%_0.11_28)] bg-[oklch(93%_0.035_28)] px-4 py-3 text-sm text-[oklch(34%_0.1_28)]">
              {accessError}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={accessState === "working"}
            className="min-h-11 justify-self-start bg-[oklch(28%_0.055_252)] px-5 text-sm font-semibold text-[oklch(97%_0.012_82)] transition-colors duration-150 hover:bg-[oklch(34%_0.06_252)] motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 disabled:opacity-60"
          >
            {accessState === "working" ? "Recording access…" : "Open conversation"}
          </button>
        </form>
      </section>
    );
  }

  return (
    <section aria-labelledby="conversation-transcript-heading" className="mt-8">
      <header className="grid gap-5 border-b-2 border-[oklch(35%_0.055_252)] pb-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[oklch(45%_0.06_65)]">
            Time-limited access
          </p>
          <h2 id="conversation-transcript-heading" className="mt-2 text-2xl font-semibold tracking-[-0.035em]">
            Transcript
          </h2>
          <p className="mt-2 text-sm text-[oklch(42%_0.035_252)]">
            Grant expires <time dateTime={new Date(grant.expiresAt).toISOString()}>{formatDateTime(grant.expiresAt)} UTC</time>. Sensitive fields are masked.
          </p>
        </div>
        <PermissionBoundary resource="conversation" action="export">
          <button
            type="button"
            onClick={prepareExport}
            className="min-h-11 border border-[oklch(48%_0.045_252)] px-5 text-sm font-semibold transition-colors duration-150 hover:bg-[oklch(89%_0.04_78)] motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
          >
            Prepare export
          </button>
        </PermissionBoundary>
      </header>

      {exportOpen ? (
        <form onSubmit={submitExport} className="my-7 grid gap-5 border-y border-[oklch(68%_0.055_65)] bg-[oklch(93%_0.035_72)] px-5 py-6 lg:grid-cols-2">
          <div className="lg:col-span-2">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[oklch(42%_0.075_60)]">Controlled export</p>
            <p className="mt-2 text-sm leading-6">Type <strong>{`EXPORT ${chatId}`}</strong> to queue an auditable transcript export.</p>
          </div>
          <label className="grid gap-2 text-sm font-semibold">
            Reason for export
            <textarea name="reason" required minLength={3} maxLength={500} rows={3} className={`${fieldClass} min-h-24 resize-y`} />
          </label>
          <label className="grid content-start gap-2 text-sm font-semibold">
            Exact export confirmation
            <input
              name="confirmation"
              required
              autoComplete="off"
              pattern={`EXPORT ${chatId}`}
              className={fieldClass}
            />
          </label>
          <label className="grid content-start gap-2 text-sm font-semibold">
            Confirm your password
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className={fieldClass}
            />
          </label>
          {exportState === "error" ? (
            <p role="alert" className="lg:col-span-2 text-sm text-[oklch(34%_0.1_28)]">{exportError}</p>
          ) : null}
          {exportState === "queued" ? (
            <div role="status" className="lg:col-span-2 border-y border-[oklch(63%_0.07_145)] bg-[oklch(93%_0.035_145)] px-4 py-3 text-sm text-[oklch(34%_0.07_145)]"><p>{exportStatus?.status === "ready" ? "Export ready for one-time download." : exportStatus?.status === "failed" ? "Export processing failed. Prepare a new export to retry." : exportStatus?.status === "expired" ? "Export expired. Prepare a new export." : "Export queued and building."}</p>{exportError ? <p role="alert" className="mt-2">{exportError}</p> : null}{exportStatus?.status === "ready" ? <button type="button" disabled={downloadWorking} onClick={() => void downloadExport()} className="mt-3 min-h-11 border border-current px-4 font-semibold disabled:opacity-60">Download once</button> : null}</div>
          ) : null}
          <div className="flex flex-wrap gap-3 lg:col-span-2">
            <button type="submit" disabled={exportState === "working" || exportState === "queued"} className="min-h-11 bg-[oklch(28%_0.055_252)] px-5 text-sm font-semibold text-[oklch(97%_0.012_82)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 disabled:opacity-60">
              {exportState === "working" ? "Queueing export…" : "Queue conversation export"}
            </button>
            <button type="button" onClick={() => setExportOpen(false)} className="min-h-11 px-4 text-sm font-semibold underline decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700">
              Close export controls
            </button>
          </div>
        </form>
      ) : null}

      <ol className="divide-y divide-[oklch(76%_0.025_78)]" aria-label="Conversation messages">
        {messages.map((message) => (
          <li key={message.id} className="grid gap-4 py-7 lg:grid-cols-[9rem_minmax(0,1fr)]">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.15em] text-[oklch(43%_0.055_252)]">
                {message.role === "user" ? "User" : "Assistant"}
              </p>
              <time className="mt-1 block text-xs text-[oklch(48%_0.03_252)]" dateTime={new Date(message.createdAt).toISOString()}>
                {formatDateTime(message.createdAt)} UTC
              </time>
            </div>
            <div className="markdown-content min-w-0 leading-7 [overflow-wrap:anywhere]">
              <ReactMarkdown
                skipHtml
                urlTransform={safeMarkdownUrl}
                components={{
                  img: () => null,
                  a: ({ href, children }) =>
                    href ? (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {children}
                      </a>
                    ) : (
                      <span>{children}</span>
                    ),
                }}
              >
                {message.content}
              </ReactMarkdown>
            </div>
          </li>
        ))}
      </ol>

      {messagesStatus === "CanLoadMore" ? (
        <button type="button" onClick={() => loadMore(50)} className="mt-5 min-h-11 border border-[oklch(48%_0.045_252)] px-5 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700">
          Load 50 more messages
        </button>
      ) : null}
      {messagesStatus === "LoadingMore" || messagesStatus === "LoadingFirstPage" ? (
        <p role="status" className="mt-5 text-sm">Loading protected messages…</p>
      ) : null}
    </section>
  );
}
