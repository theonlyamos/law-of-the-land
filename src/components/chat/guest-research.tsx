"use client";

import type { GuestSessionView } from "@/convex/lib/guestResearchContracts";
import { AssistantMessage } from "@/components/chat/assistant-message";
import { AssistantMessageFooter } from "@/components/chat/assistant-message-footer";
import { Button } from "@/components/ui/button";
import { ChatInput } from "@/components/ui/chat-input";
import { PageLoader, Spinner } from "@/components/ui/spinner";
import { clearGuestResearchDraft, readGuestResearchDraft, saveGuestResearchDraft } from "@/lib/guest-research-draft";
import { useConvexAuth } from "convex/react";
import { Globe2, LockKeyhole } from "lucide-react";
import Image from "next/image";
import logo from "@/app/logo-transparent.png";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

const SIGNUP = "/signin?mode=signup&redirect=%2Fresearch";
const REQUEST_KEY = "guest-research-request";
const REQUEST_TTL_MS = 24 * 60 * 60_000;
type Request = { requestId: string; query: string; jurisdictionId: string };

function rememberedRequest(): Request | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(REQUEST_KEY) ?? "null");
    if (value && typeof value === "object" && !Array.isArray(value)
      && "requestId" in value && typeof value.requestId === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.requestId)
      && "query" in value && typeof value.query === "string" && value.query.trim().length > 0 && value.query.length <= 4000
      && "jurisdictionId" in value && typeof value.jurisdictionId === "string" && value.jurisdictionId.length > 0 && value.jurisdictionId.length <= 128
      && "expiresAt" in value && typeof value.expiresAt === "number"
      && value.expiresAt > Date.now() && value.expiresAt <= Date.now() + REQUEST_TTL_MS) {
      return { requestId: value.requestId, query: value.query, jurisdictionId: value.jurisdictionId };
    }
  } catch { /* Invalid storage must not block research. */ }
  rememberRequest(null);
  return null;
}

function rememberRequest(value: Request | null) {
  try {
    if (value) sessionStorage.setItem(REQUEST_KEY, JSON.stringify({ ...value, expiresAt: Date.now() + REQUEST_TTL_MS }));
    else sessionStorage.removeItem(REQUEST_KEY);
  } catch { /* The server remains authoritative when browser storage is unavailable. */ }
}

async function guestApi<T>(path = "/api/guest-research", body?: unknown, method = "POST"): Promise<T> {
  const response = await fetch(path, body === undefined ? { cache: "no-store" } : {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message ?? "We could not load your research. Please try again.");
  return data as T;
}

export function GuestResearch({ initialQuery, initialJurisdiction }: {
  initialQuery: string | null; initialJurisdiction: string | null;
}) {
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const [session, setSession] = useState<GuestSessionView | null>(null);
  const [restored, setRestored] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [localRequest, setLocalRequest] = useState<Request | null>(null);
  const requestRef = useRef<Request | null>(null);
  const busyRef = useRef(false);
  const bootstrapRef = useRef(false);
  const claimRef = useRef(false);
  const jurisdictionId = session?.jurisdictionId ?? initialJurisdiction;
  const pending = session?.turns.some((turn) => turn.status === "pending") ?? false;
  const hasAnswer = session?.turns.some((turn) => turn.status === "completed" && turn.result) ?? false;
  const remaining = session?.remaining ?? 2;

  const updateQuery = useCallback((value: string) => {
    setQuery(value);
    saveGuestResearchDraft(value);
  }, []);

  const acceptSession = useCallback((value: GuestSessionView | null) => {
    setSession(value);
    setError("");
    const request = requestRef.current;
    const turn = value?.turns.find((item) => item.requestId === request?.requestId);
    if (!turn || turn.status === "pending") return;
    requestRef.current = null;
    rememberRequest(null);
    setLocalRequest(null);
    if (turn.status === "completed") {
      setQuery((current) => current === request!.query ? "" : current);
      if (readGuestResearchDraft() === request!.query) clearGuestResearchDraft();
    } else {
      updateQuery(request!.query);
      setError(turn.error?.message ?? "We could not finish that answer. Your trial allowance has not been used. Please try again.");
    }
  }, [updateQuery]);

  const restore = useCallback(async () => {
    try {
      acceptSession(await guestApi<GuestSessionView | null>());
      setRestored(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "We could not load your research. Please try again.");
    }
  }, [acceptSession]);

  useEffect(() => {
    let active = true;
    requestRef.current = rememberedRequest();
    setLocalRequest(requestRef.current);
    setQuery(readGuestResearchDraft() || initialQuery || requestRef.current?.query || "");
    void guestApi<GuestSessionView | null>().then((value) => {
      if (!active) return;
      acceptSession(value);
      setRestored(true);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : "We could not load your research. Please try again.");
    });
    return () => { active = false; };
    // Initial URL values seed this visit; removing the submitted query must not reset the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acceptSession]);

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !jurisdictionId || busyRef.current || pending) return;
    if (remaining <= 0) {
      saveGuestResearchDraft(text);
      router.push(SIGNUP);
      return;
    }
    busyRef.current = true;
    const previous = requestRef.current;
    const request = previous?.query === trimmed && previous.jurisdictionId === jurisdictionId
      ? previous : { requestId: crypto.randomUUID(), query: trimmed, jurisdictionId };
    requestRef.current = request;
    rememberRequest(request);
    setLocalRequest(request);
    setSending(true);
    setError("");
    updateQuery("");
    router.replace("/research", { scroll: false });
    try {
      if (!session) acceptSession(await guestApi<GuestSessionView>("/api/guest-research", { jurisdictionId }, "PUT"));
      acceptSession(await guestApi<GuestSessionView>("/api/guest-research", request));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "We could not finish that answer. Please try again.";
      try {
        const current = await guestApi<GuestSessionView | null>();
        acceptSession(current);
        const turn = current?.turns.find((item) => item.requestId === request.requestId);
        if (turn?.status === "completed" || turn?.status === "pending") return;
      } catch { /* Retain the request ID so an ambiguous network failure can be retried safely. */ }
      updateQuery(request.query);
      setError(message);
    } finally {
      busyRef.current = false;
      setSending(false);
    }
  }, [acceptSession, jurisdictionId, pending, remaining, router, session, updateQuery]);

  useEffect(() => {
    if (!restored || authLoading || isAuthenticated || bootstrapRef.current) return;
    bootstrapRef.current = true;
    if (!session?.turns.length && initialQuery?.trim() && initialJurisdiction
      && (!session || session.jurisdictionId === initialJurisdiction)) {
      void send(initialQuery);
    }
  }, [authLoading, initialJurisdiction, initialQuery, isAuthenticated, restored, send, session]);

  useEffect(() => {
    if (!pending) return;
    let active = true;
    let polling = false;
    const timer = window.setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const value = await guestApi<GuestSessionView | null>();
        if (active) acceptSession(value);
      } catch {
        if (active) setError("Your answer is still being checked. Reconnecting…");
      } finally { polling = false; }
    }, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [acceptSession, pending]);

  const claim = useCallback(async () => {
    if (claimRef.current || pending || sending || !hasAnswer) return;
    claimRef.current = true;
    setClaiming(true);
    setError("");
    try {
      const { chatId } = await guestApi<{ chatId: string }>("/api/guest-research/claim", {});
      const draft = query || readGuestResearchDraft();
      if (draft) saveGuestResearchDraft(draft, chatId);
      clearGuestResearchDraft();
      rememberRequest(null);
      router.replace(`/${chatId}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "We could not save your research. Please try again.");
      setClaiming(false);
      claimRef.current = false;
    }
  }, [hasAnswer, pending, query, router, sending]);

  useEffect(() => {
    if (!isAuthenticated || authLoading || !restored || pending || sending) return;
    if (hasAnswer) { void claim(); return; }
    if (claimRef.current) return;
    claimRef.current = true;
    const selection = initialJurisdiction ?? session?.jurisdictionId ?? requestRef.current?.jurisdictionId;
    if (!selection) { router.replace("/new"); return; }
    const chatId = crypto.randomUUID();
    saveGuestResearchDraft(query || readGuestResearchDraft() || initialQuery || session?.turns.at(-1)?.query || "", chatId);
    clearGuestResearchDraft();
    rememberRequest(null);
    router.replace(`/${chatId}?jurisdiction=${encodeURIComponent(selection)}`);
  }, [authLoading, claim, hasAnswer, initialJurisdiction, initialQuery, isAuthenticated, pending, query, restored, router, sending, session]);

  if ((!restored || authLoading) && !error) return <PageLoader label="Loading your research…" />;
  const visibleTurns = session?.turns.filter((turn) => turn.status === "completed" || turn.status === "pending") ?? [];
  const localOnly = localRequest && !session?.turns.some((turn) => turn.requestId === localRequest.requestId);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-8 sm:px-8 sm:py-12">
      <header className="mb-10 flex flex-wrap items-start justify-between gap-5">
        <div>
          <p className="chat-eyebrow mb-4">{session?.jurisdictionName ?? "Guest research"}</p>
          <h1 className="chat-heading">Your research</h1>
          <p className="mt-4 text-sm leading-7 text-muted-foreground">Ask in plain language. Explore the sources behind your answer.</p>
        </div>
        {!isAuthenticated && hasAnswer && (
          <Link href={SIGNUP} className="inline-flex min-h-11 items-center rounded-full border border-input px-4 py-2 text-xs font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Save this research — create a free account</Link>
        )}
      </header>
      {initialJurisdiction && session && initialJurisdiction !== session.jurisdictionId && <p role="status" className="mb-6 border-l-2 border-amber-700 pl-3 text-sm text-muted-foreground">
        Your guest trial is already in {session.jurisdictionName}. Follow-up questions below use that jurisdiction. Create a free account to start research in another jurisdiction.
      </p>}
      <div aria-label="Research conversation">
        {visibleTurns.map((turn) => (
          <section key={turn.requestId} className="mb-10">
            <div className="mb-7 flex justify-end">
              <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-secondary px-5 py-3 text-sm leading-relaxed text-secondary-foreground [overflow-wrap:anywhere]">{turn.query}</p>
            </div>
            {turn.result && <div className="min-w-0 text-sm leading-7">
              <div className="mb-4 flex items-center gap-2 text-xs font-semibold">
                <Image src={logo} alt="" width={27} height={20} className="h-5 w-7 object-contain" />
                Law of the Land
              </div>
              <div className="markdown-content"><AssistantMessage content={turn.result.answer} /></div>
              {turn.result.citations.length > 0 && <section aria-label="Sources" className="mt-6 border-t pt-4 text-xs leading-5 text-muted-foreground">
                <h2 className="text-[11px] font-semibold uppercase tracking-wider">Sources · {turn.result.citations.length}</h2>
                <ol className="mt-3 space-y-2">
                  {turn.result.citations.map((citation, index) => (
                    <li key={`${citation.jurisdictionId}-${index}`} className="chat-source">
                      <span className="chat-source-number" aria-hidden="true">{index + 1}</span>
                      <div className="min-w-0 [overflow-wrap:anywhere]">
                      {citation.sourceUrl && /^https?:\/\//i.test(citation.sourceUrl)
                        ? <a href={citation.sourceUrl} target="_blank" rel="noopener noreferrer" aria-label={`${citation.label} (opens in a new tab)`} className="font-medium text-foreground underline underline-offset-4">{citation.label}</a>
                        : <span className="font-medium text-foreground">{citation.label}</span>}
                        <p>{citation.jurisdictionName}{citation.officialCitation ? ` · ${citation.officialCitation}` : ""}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>}
              {turn.result.partialCoverage && <p role="status" className="mt-3 border-l-2 border-amber-700 pl-3 text-xs leading-5 text-muted-foreground">Partial coverage: some public sources were unavailable for this answer.</p>}
              <AssistantMessageFooter content={turn.result.answer} citations={turn.result.citations} completedAt={turn.result.completedAt} savedAt={turn.result.completedAt} />
            </div>}
          </section>
        ))}
        {localOnly && sending && <div className="mb-7 flex justify-end"><p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-secondary px-5 py-3 text-sm leading-relaxed text-secondary-foreground [overflow-wrap:anywhere]">{localRequest.query}</p></div>}
        {(sending || pending || claiming) && <p role="status" className="mb-6 flex items-center gap-3 text-sm text-muted-foreground"><Spinner className="size-4 shrink-0" />{claiming ? "Saving your research to your account…" : "Researching your question and checking sources…"}</p>}
      </div>
      {error && <div role="alert" className="mb-5 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm leading-6 text-destructive">
        <p>{error}</p>
        {!restored && <Button variant="outline" className="mt-2 min-h-11 rounded-full" onClick={() => void restore()}>Try again</Button>}
        {isAuthenticated && hasAnswer && !claiming && <Button variant="outline" className="mt-2 min-h-11 rounded-full" onClick={() => void claim()}>Save research again</Button>}
      </div>}
      {restored && !isAuthenticated && <div className="mt-8">
        <p id="guest-allowance" className="mb-4 text-xs leading-6 text-muted-foreground">
          {remaining === 0 ? "You’ve used your guest research trial. Create a free account to continue and save this conversation."
            : remaining === 1 ? "One free follow-up remaining. No account required."
            : "Try one question and one follow-up free. No account required."}
        </p>
        {jurisdictionId ? <>
          <label htmlFor="guest-question" className="sr-only">{remaining === 0 ? "Your next question" : "Your legal question"}</label>
          <ChatInput id="guest-question" variant="editorial" ariaLabel={remaining === 0 ? "Your next question" : "Your legal question"}
            describedBy="guest-allowance" maxLength={4000} rows={2}
            query={query} onQueryChange={updateQuery} isLoading={sending || pending}
            onSearch={() => void send(query)}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(query); } }}
            footer={<span className="chat-scope-label" title={`${session?.jurisdictionName ?? "Selected jurisdiction"} — fixed for this conversation`}>
              <Globe2 className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{session?.jurisdictionName ?? "Selected jurisdiction"}</span>
              <LockKeyhole className="size-3 shrink-0" aria-label="Fixed for this conversation" />
            </span>}
            placeholder={remaining === 2 ? "What would you like to understand?" : "Ask a follow-up…"} />
        </> : <Link href="/" className="inline-flex min-h-11 items-center text-sm underline underline-offset-4">Choose a jurisdiction and start your research</Link>}
        {remaining === 0 && <Button asChild className="mt-5 min-h-11 rounded-full px-5"><Link href={SIGNUP}>Create a free account</Link></Button>}
        <p className="mt-4 text-xs leading-6 text-muted-foreground">{remaining === 0 ? "Free accounts have a daily question allowance. Paid plans offer higher limits. " : ""}Guest research stays in this browser for up to 24 hours. Create an account to keep it.</p>
      </div>}
    </main>
  );
}
