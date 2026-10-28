"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import {
  PROFILE_FACT_CATALOG,
  PROFILE_FACT_TYPES,
  PROFILE_MEMORY_LIMITS,
  profileFactLabel,
  type ProfileFactType,
} from "../../../shared/profile-memory";

const SOURCE_LABEL = { stated: "You said", implied: "From your questions", user: "Added by you" } as const;

function formatDate(value: number) {
  return new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

type Scope = NonNullable<ReturnType<typeof useQuery<typeof api.profileMemory.overview>>>["scopes"][number];

function AddFactForm({ organizationId, full }: { organizationId?: Id<"organizations">; full: boolean }) {
  const addFact = useMutation(api.profileMemory.addFact);
  const [type, setType] = useState<ProfileFactType>("role");
  const [value, setValue] = useState<string>(Object.keys(PROFILE_FACT_CATALOG.role.values)[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await addFact({ type, value, ...(organizationId ? { organizationId } : {}) });
    } catch (caught) {
      setError(caught instanceof Error && caught.message.includes("PROFILE_MEMORY_FULL")
        ? `Memory holds up to ${PROFILE_MEMORY_LIMITS.maxConfirmed} facts here. Remove one to add another.`
        : "We could not save that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const select = "h-9 min-w-0 rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-wrap items-end gap-2">
      <label className="grid gap-1 text-xs text-muted-foreground">
        Type
        <select className={select} value={type} onChange={(event) => {
          const next = event.target.value as ProfileFactType;
          setType(next);
          setValue(Object.keys(PROFILE_FACT_CATALOG[next].values)[0]);
        }}>
          {PROFILE_FACT_TYPES.map((option) => <option key={option} value={option}>{PROFILE_FACT_CATALOG[option].label}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-xs text-muted-foreground">
        Value
        <select className={select} value={value} onChange={(event) => setValue(event.target.value)}>
          {Object.entries(PROFILE_FACT_CATALOG[type].values).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      </label>
      <Button type="submit" variant="outline" size="sm" disabled={busy || full}>{busy ? "Saving…" : "Remember this"}</Button>
      {error && <p role="alert" className="basis-full text-xs text-destructive">{error}</p>}
    </form>
  );
}

function ScopeSection({ scope }: { scope: Scope }) {
  const removeFact = useMutation(api.profileMemory.removeFact);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState(false);

  async function remove(id: Id<"userProfileFacts">) {
    setRemoving(id);
    setError(false);
    try { await removeFact({ factId: id }); }
    catch { setError(true); }
    finally { setRemoving(null); }
  }

  return (
    <section aria-labelledby={`memory-${scope.scope}`} className="space-y-3 border-t pt-5 first:border-t-0 first:pt-0">
      <div>
        <h2 id={`memory-${scope.scope}`} className="text-sm font-semibold">{scope.name}</h2>
        <p className="text-xs text-muted-foreground">
          {scope.organizationId ? `Used only in ${scope.name} chats.` : "Used in all your chats."}
        </p>
      </div>
      {scope.facts.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing remembered yet.</p>
      ) : (
        <ul className="space-y-2">
          {scope.facts.map((fact) => (
            <li key={fact.id} className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5">
              <div className="min-w-0 text-sm">
                <p><span className="text-muted-foreground">{PROFILE_FACT_CATALOG[fact.type].label}:</span>{" "}
                  <span className="font-medium">{profileFactLabel(fact.type, fact.value)}</span></p>
                <p className="mt-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {SOURCE_LABEL[fact.source]}
                  {fact.quote ? <> · “{fact.quote}”</> : null}
                  {fact.confirmedAt ? <> · {formatDate(fact.confirmedAt)}</> : null}
                </p>
              </div>
              <Button type="button" variant="ghost" size="sm" disabled={removing === fact.id}
                aria-label={`Forget ${profileFactLabel(fact.type, fact.value)}`} onClick={() => void remove(fact.id)}>
                <X className="size-4" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="text-xs text-destructive">We could not remove that. Try again.</p>}
      <AddFactForm organizationId={scope.organizationId} full={scope.facts.length >= PROFILE_MEMORY_LIMITS.maxConfirmed} />
    </section>
  );
}

export function MemorySettings() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const overview = useQuery(api.profileMemory.overview, isAuthenticated ? {} : "skip");
  const setEnabled = useMutation(api.profileMemory.setEnabled);
  const clearAll = useMutation(api.profileMemory.clearAll);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isLoading || (isAuthenticated && overview === undefined)) {
    return <div className="flex min-h-[40vh] items-center justify-center"><Spinner /></div>;
  }
  if (!isAuthenticated || !overview) {
    return (
      <div className="container mx-auto max-w-3xl px-4 py-10">
        <Card><CardHeader><CardTitle>Memory</CardTitle>
          <CardDescription><Link href="/signin" className="underline underline-offset-4">Sign in</Link> to manage what Law of the Land remembers.</CardDescription>
        </CardHeader></Card>
      </div>
    );
  }

  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    try { await action(); }
    catch { setError(message); }
    finally { setBusy(false); }
  }

  return (
    <div className="container mx-auto max-w-3xl px-4 py-10">
      <Card>
        <CardHeader>
          <CardTitle>Memory</CardTitle>
          <CardDescription>
            Law of the Land remembers a few things about you, such as whether you ask as a tenant or a lawyer, so answers fit you better.
            It only uses facts you state or that come up again and again. It never stores health, money, family or case details,
            and memory never changes what the law says.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {!overview.available && (
            <p role="status" className="rounded-md border px-3 py-2 text-sm text-muted-foreground">Memory is not switched on for this app yet. Anything you add here will be used once it is.</p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3">
            <div>
              <p className="text-sm font-medium">{overview.enabled ? "Memory is on" : "Memory is paused"}</p>
              <p className="text-xs text-muted-foreground">
                {overview.enabled ? "New questions can add to it, and answers use it." : "Nothing new is remembered and answers don't use it."}
              </p>
            </div>
            <Button type="button" variant="outline" size="sm" disabled={busy}
              onClick={() => void run(() => setEnabled({ enabled: !overview.enabled }), "We could not change that setting. Try again.")}>
              {overview.enabled ? "Pause memory" : "Turn memory on"}
            </Button>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {overview.scopes.map((scope) => <ScopeSection key={scope.scope} scope={scope} />)}
          <div className="border-t pt-5">
            {confirmClear ? (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm">Forget everything Law of the Land remembers about you?</p>
                <Button type="button" variant="destructive" size="sm" disabled={busy}
                  onClick={() => void run(async () => { await clearAll({}); setConfirmClear(false); }, "We could not clear memory. Try again.")}>
                  Forget everything
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmClear(false)}>Cancel</Button>
              </div>
            ) : (
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmClear(true)}>Clear all memory</Button>
            )}
            <p className="mt-2 text-xs text-muted-foreground">Deleting a chat also forgets what was learned from it. You can turn memory off for a single chat below its question box.</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
