"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { ChatInput } from "@/components/ui/chat-input";
import dynamic from "next/dynamic";
import { frameMessage } from "@/lib/embed/messages";
import type { Done } from "@/lib/embed/client";
import type { WidgetConfig } from "@/convex/lib/widgetContracts";

type Entry = { query: string; requestId: string; result?: Done };
const AssistantMessage = dynamic(() => import("@/components/chat/assistant-message").then(module => module.AssistantMessage));
export function GuestChat({ config, parentOrigin = "", instanceId = "", preview = false }: { config: WidgetConfig; parentOrigin?: string; instanceId?: string; preview?: boolean }) {
  const [ready, setReady] = useState(preview), [query, setQuery] = useState(""), [entries, setEntries] = useState<Entry[]>([]);
  const [status, setStatus] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false), [unresolved, setUnresolved] = useState<Entry | null>(null);
  const token = useRef<string | null>(null), active = useRef<AbortController | null>(null), serial = useRef(0), locked = useRef(false), root = useRef<HTMLDivElement>(null), bottom = useRef<HTMLDivElement>(null);
  const base = `/api/embed/${encodeURIComponent(config.publicId)}`;
  function post(type: string) { if (!preview) window.parent.postMessage({ namespace: "lotl-widget", version: 1, embedId: config.publicId, instanceId, type, payload: {} }, parentOrigin); }
  useEffect(() => {
    if (preview) return;
    let initialized = false;
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== parentOrigin || !frameMessage(event.data, config.publicId, instanceId, ["init", "opened", "closed"])) return;
      if (event.data.type === "init") { initialized = true; setReady(true); }
      if (event.data.type === "opened" && initialized) requestAnimationFrame(() => root.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus());
    };
    window.addEventListener("message", receive);
    window.parent.postMessage({ namespace: "lotl-widget", version: 1, embedId: config.publicId, instanceId, type: "ready", payload: {} }, parentOrigin);
    return () => { window.removeEventListener("message", receive); serial.current++; active.current?.abort(); token.current = null; };
  }, [config.publicId, instanceId, parentOrigin, preview]);
  useEffect(() => { bottom.current?.scrollIntoView?.({ block: "nearest" }); }, [entries, status]);
  function commit(result: Done, run: number) {
    if (serial.current !== run) return;
    setEntries(rows => rows.map(row => row.requestId === result.requestId ? { ...row, result } : row));
    setUnresolved(null); setError(""); setStatus("");
  }
  async function check(entry: Entry, run = serial.current): Promise<boolean> {
    if (!token.current || serial.current !== run) return false;
    const { errorSchema, turnSchema } = await import("@/lib/embed/client");
    const response = await fetch(`${base}/chat?requestId=${entry.requestId}`, { credentials: "omit", cache: "no-store", headers: { authorization: `Bearer ${token.current}` }, signal: AbortSignal.timeout(10000) });
    const body = await response.json();
    if (serial.current !== run) return true;
    if (!response.ok) { const parsed = errorSchema.safeParse(body.error); if (parsed.success) setError(parsed.data.message); return true; }
    const turn = turnSchema.parse(body);
    if (turn.requestId !== entry.requestId) throw new Error("Answer mismatch.");
    if (turn.status === "completed" && turn.result?.requestId === entry.requestId) { commit(turn.result, run); return true; }
    if (turn.status !== "pending") { setError(turn.error?.message ?? "This answer wasn't completed. You can ask again."); return true; }
    return false;
  }
  async function send(text = query) {
    if (preview || !ready || locked.current || !text.trim() || text.length > 4000) return;
    locked.current = true; setBusy(true); setError(""); setStatus("Connecting…");
    const run = ++serial.current, controller = new AbortController(); active.current = controller;
    const entry = { query: text.trim(), requestId: crypto.randomUUID() };
    let submitted = false;
    try {
      const { readAnswer, errorSchema } = await import("@/lib/embed/client");
      if (!token.current) {
        const response = await fetch(`${base}/session`, { method: "POST", credentials: "omit", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ parentOrigin }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
        const body = await response.json();
        if (!response.ok || typeof body.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.token)) throw new Error(errorSchema.safeParse(body.error).success ? body.error.message : "This assistant couldn't connect. Please try again.");
        if (serial.current !== run) return;
        token.current = body.token;
      }
      setEntries(rows => [...rows, entry]); setQuery(""); setUnresolved(entry); submitted = true;
      const response = await fetch(`${base}/chat`, { method: "POST", credentials: "omit", cache: "no-store", headers: { "content-type": "application/json", authorization: `Bearer ${token.current}` }, body: JSON.stringify({ requestId: entry.requestId, query: entry.query }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(115000)]) });
      const result = await readAnswer(response, entry.requestId, text => { if (serial.current === run) setStatus(text); });
      if (result) { commit(result, run); return; }
    } catch (caught) { if (serial.current === run) setError(caught instanceof Error ? caught.message : "The connection was interrupted."); }
    finally { if (serial.current === run) { setStatus(""); } }
    if (submitted && serial.current === run && !controller.signal.aborted) {
      setStatus("Checking whether your answer finished…");
      for (const delay of [2000, 3000, 5000]) {
        await new Promise<void>(resolve => { const id = setTimeout(resolve, delay); controller.signal.addEventListener("abort", () => { clearTimeout(id); resolve(); }, { once: true }); });
        if (serial.current !== run || controller.signal.aborted) break;
        try { if (await check(entry, run)) break; } catch { /* Manual recovery remains available. */ }
      }
    }
    if (serial.current === run) { setStatus(""); }
  }
  async function submit(text?: string) { if (locked.current) return; const run = serial.current + 1; try { await send(text); } finally { if (serial.current === run) { locked.current = false; setBusy(false); } } }
  async function stop() {
    active.current?.abort();
    if (unresolved && token.current) {
      try { await fetch(`${base}/chat?requestId=${unresolved.requestId}`, { method: "DELETE", credentials: "omit", headers: { authorization: `Bearer ${token.current}` }, signal: AbortSignal.timeout(10000) }); } catch { setError("The connection was interrupted. Check the answer before asking again."); }
    }
  }
  function reset() {
    serial.current++; active.current?.abort();
    const previous = token.current; token.current = null;
    if (previous) void fetch(`${base}/session`, { method: "DELETE", credentials: "omit", headers: { authorization: `Bearer ${previous}` }, signal: AbortSignal.timeout(10000) }).catch(() => {});
    setEntries([]); setUnresolved(null); setQuery(""); setError(""); setStatus(""); setBusy(false); locked.current = false;
  }
  return <div ref={root} role={preview ? undefined : "dialog"} aria-modal={preview ? undefined : true} aria-label={config.title} className="flex h-dvh min-h-0 flex-col break-words bg-background text-foreground" style={{ borderTop: `4px solid ${config.accent}`, ...(preview ? { height: 540 } : {}) } as CSSProperties} onKeyDown={event => {
    if (preview) return;
    if (event.key === "Escape") { event.preventDefault(); post("close"); }
    if (event.key === "Tab") { const elements = Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled),a[href],summary') ?? []); const first = elements[0], last = elements.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
  }}>
    <header className="flex items-start justify-between gap-3 border-b p-4"><div className="min-w-0"><h1 className="font-semibold">{config.title}</h1><p className="text-xs text-muted-foreground">{config.jurisdictionName}</p></div><div className="flex shrink-0"><Button variant="ghost" size="sm" disabled={preview} onClick={reset}>Start over</Button><Button variant="ghost" size="sm" disabled={preview} onClick={() => post("close")} aria-label="Close chat">×</Button></div></header>
    <div className="min-h-0 flex-1 overflow-y-auto p-4" aria-label="Conversation">
      <p className="mb-4 text-sm">{config.welcomeMessage}</p>
      {!entries.length && <div className="grid gap-2">{config.suggestedQuestions.map((question, index) => <Button key={index} variant="outline" className="h-auto whitespace-normal py-3 text-left" disabled={preview || !ready || busy} onClick={() => void submit(question)}>{question}</Button>)}</div>}
      <ol className="space-y-5" aria-live="polite" aria-relevant="additions text">{entries.map(entry => <li key={entry.requestId}><p className="mb-3 rounded-lg bg-muted p-3 text-sm whitespace-pre-wrap break-words">{entry.query}</p>{entry.result && <><div className="prose prose-sm dark:prose-invert max-w-none break-words"><AssistantMessage content={entry.result.answer} /></div>{entry.result.citations.length > 0 && <details className="mt-3 text-xs"><summary className="cursor-pointer font-medium">Sources ({entry.result.citations.length})</summary><ul className="mt-2 space-y-3">{entry.result.citations.map((source, index) => <li key={index}><strong>{source.label}</strong><p>{source.issuer} · {source.officialCitation}</p>{source.effectiveDate && <p>Effective {source.effectiveDate}</p>}{source.sourceUrl?.startsWith("https://") && <a href={source.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline">View official source</a>}</li>)}</ul></details>}</>}</li>)}</ol>
      <p role="status" className="mt-4 text-sm text-muted-foreground">{status}</p>{error && <p role="alert" className="mt-3 text-sm">{error}</p>}
      {unresolved && !busy && <div className="mt-3 flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={async () => { setBusy(true); try { await check(unresolved); } catch { setError("We couldn't check this answer. Please try again."); } finally { setBusy(false); } }}>Check answer</Button><Button variant="outline" size="sm" onClick={() => void submit(unresolved.query)}>Ask again</Button></div>}
      <div ref={bottom} />
    </div>
    <footer className="space-y-2 border-t p-4"><label htmlFor={preview ? "preview-question" : "guest-question"} className="text-sm font-medium">Your question</label><ChatInput id={preview ? "preview-question" : "guest-question"} maxLength={4000} describedBy={preview ? "preview-notice" : "guest-notice"} query={query} onQueryChange={setQuery} onSearch={() => void submit()} isLoading={busy} disabled={preview || !ready || !!unresolved} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} placeholder="Ask about published documents…" />{busy && <Button size="sm" variant="ghost" onClick={() => void stop()}>Stop answer</Button>}<p id={preview ? "preview-notice" : "guest-notice"} className="text-[11px] leading-relaxed text-muted-foreground">{preview ? "Design preview only. No questions are sent." : <>Questions are processed by Law of the Land and its AI provider. Temporary chat records are scheduled for deletion after 24 hours. Don't include sensitive personal information. <a className="underline" href="/privacy" target="_blank" rel="noopener noreferrer">Privacy policy</a></>}</p><p className="text-[11px] text-muted-foreground">AI answers may be incorrect. Verify sources. This is legal information, not legal advice.</p></footer>
  </div>;
}
