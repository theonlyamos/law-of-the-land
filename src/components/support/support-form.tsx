"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ConvexError } from "convex/values";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { CheckCircle2, ImagePlus, X } from "lucide-react";
import Link from "next/link";
import { useId, useRef, useState, type FormEvent } from "react";
import {
  SUPPORT_CATEGORIES,
  SUPPORT_CATEGORY_LABELS,
  SUPPORT_LIMITS,
  SUPPORT_SCREENSHOT_TYPES,
  isAcceptableSupportScreenshot,
  type SupportCategory,
} from "../../../shared/support";

const field =
  "h-10 w-full min-w-0 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

export function supportErrorMessage(caught: unknown): string {
  if (caught instanceof ConvexError) {
    const data = caught.data as unknown;
    if (data && typeof data === "object" && "message" in data && typeof data.message === "string") return data.message;
    if (typeof data === "string") return data;
  }
  return "We couldn't send your message. Please check your connection and try again.";
}

export function SupportForm({ fromPath, initialCategory }: { fromPath?: string; initialCategory?: SupportCategory }) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const user = useQuery(api.users.current, isAuthenticated ? {} : "skip");
  const submit = useMutation(api.support.submitTicket);
  const generateUploadUrl = useMutation(api.support.generateScreenshotUploadUrl);
  const fileInput = useRef<HTMLInputElement>(null);
  const ids = { category: useId(), subject: useId(), message: useId(), name: useId(), email: useId(), file: useId() };

  const [category, setCategory] = useState<SupportCategory>(initialCategory ?? "support");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);

  function chooseScreenshot(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (!isAcceptableSupportScreenshot({ contentType: file.type, size: file.size })) {
      setError("Screenshots must be PNG, JPEG, WebP or GIF images under 5 MB.");
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    setScreenshot(file);
  }

  function clearScreenshot() {
    setScreenshot(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let screenshotId: Id<"_storage"> | undefined;
      if (screenshot && isAuthenticated) {
        const uploadUrl = await generateUploadUrl({});
        const response = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": screenshot.type }, body: screenshot });
        if (!response.ok) throw new Error("upload failed");
        screenshotId = ((await response.json()) as { storageId: Id<"_storage"> }).storageId;
      }
      const result = await submit({
        category,
        subject,
        message,
        ...(isAuthenticated ? {} : { name: name || undefined, email }),
        ...(fromPath ? { pagePath: fromPath } : {}),
        userAgent: typeof navigator === "undefined" ? undefined : navigator.userAgent,
        ...(screenshotId ? { screenshotId } : {}),
        ...(website ? { website } : {}),
      });
      setReference(result.reference);
    } catch (caught) {
      setError(supportErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function startOver() {
    setReference(null);
    setSubject("");
    setMessage("");
    clearScreenshot();
  }

  if (reference) {
    return (
      <Card>
        <CardHeader>
          <CheckCircle2 className="size-6 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          <CardTitle role="status">Message sent</CardTitle>
          <CardDescription>
            Thank you. Your reference is <span className="font-mono font-medium text-foreground">#{reference}</span>.
            {isAuthenticated
              ? " We'll reply to the email on your account."
              : " We'll reply to the email address you gave us."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button asChild variant="default" size="sm"><Link href={fromPath ?? "/"}>{fromPath ? "Back to where I was" : "Go to the homepage"}</Link></Button>
          <Button type="button" variant="outline" size="sm" onClick={startOver}>Send another message</Button>
        </CardContent>
      </Card>
    );
  }

  const signedInAs = user?.email ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Contact &amp; feedback</CardTitle>
        <CardDescription>
          Ask a question, report a problem, suggest a feature or raise a complaint. Your message goes straight to the Law of the Land team.
          We can't give legal advice about your situation here.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(event) => void onSubmit(event)} className="grid gap-5">
          <div className="grid gap-1.5">
            <label htmlFor={ids.category} className="text-sm font-medium">What is this about?</label>
            <select id={ids.category} className={field} value={category} onChange={(event) => setCategory(event.target.value as SupportCategory)} disabled={busy}>
              {SUPPORT_CATEGORIES.map((option) => <option key={option} value={option}>{SUPPORT_CATEGORY_LABELS[option]}</option>)}
            </select>
          </div>

          <div className="grid gap-1.5">
            <label htmlFor={ids.subject} className="text-sm font-medium">Subject</label>
            <input id={ids.subject} className={field} value={subject} onChange={(event) => setSubject(event.target.value)} required
              minLength={SUPPORT_LIMITS.subjectMin} maxLength={SUPPORT_LIMITS.subjectMax} placeholder="A short summary" disabled={busy} />
          </div>

          <div className="grid gap-1.5">
            <label htmlFor={ids.message} className="text-sm font-medium">Message</label>
            <Textarea id={ids.message} value={message} onChange={(event) => setMessage(event.target.value)} required
              minLength={SUPPORT_LIMITS.messageMin} maxLength={SUPPORT_LIMITS.messageMax} rows={7} disabled={busy}
              placeholder={category === "bug" ? "What did you do, what did you expect, and what happened instead?" : "Tell us as much as you can."} />
            <p className="text-xs text-muted-foreground">Please don't include passwords or sensitive personal details.</p>
          </div>

          {isLoading ? null : isAuthenticated ? (
            <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              We'll reply to {signedInAs ? <span className="font-medium text-foreground">{signedInAs}</span> : "the email on your account"}.
            </p>
          ) : (
            <div className="grid gap-5 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <label htmlFor={ids.name} className="text-sm font-medium">Name <span className="font-normal text-muted-foreground">(optional)</span></label>
                <input id={ids.name} className={field} value={name} onChange={(event) => setName(event.target.value)} maxLength={SUPPORT_LIMITS.nameMax} autoComplete="name" disabled={busy} />
              </div>
              <div className="grid gap-1.5">
                <label htmlFor={ids.email} className="text-sm font-medium">Email</label>
                <input id={ids.email} type="email" className={field} value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={SUPPORT_LIMITS.emailMax} autoComplete="email" disabled={busy} />
              </div>
            </div>
          )}

          {isAuthenticated ? (
            <div className="grid gap-1.5">
              <span className="text-sm font-medium">Screenshot <span className="font-normal text-muted-foreground">(optional)</span></span>
              {screenshot ? (
                <div className="flex min-w-0 items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                  <span className="truncate">{screenshot.name}</span>
                  <Button type="button" variant="ghost" size="sm" onClick={clearScreenshot} disabled={busy} aria-label="Remove screenshot"><X className="size-4" /></Button>
                </div>
              ) : (
                <label htmlFor={ids.file} className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed px-3 py-3 text-sm text-muted-foreground hover:bg-muted/40 focus-within:ring-1 focus-within:ring-ring">
                  <ImagePlus className="size-4" aria-hidden="true" />
                  Attach an image (PNG, JPEG, WebP or GIF, up to 5 MB)
                  <input id={ids.file} ref={fileInput} type="file" accept={SUPPORT_SCREENSHOT_TYPES.join(",")} className="sr-only"
                    onChange={(event) => chooseScreenshot(event.target.files?.[0])} disabled={busy} />
                </label>
              )}
            </div>
          ) : !isLoading ? (
            <p className="text-xs text-muted-foreground">
              <Link href={`/signin?redirect=${encodeURIComponent("/support")}`} className="underline underline-offset-4">Sign in</Link> to attach a screenshot.
            </p>
          ) : null}

          {/* Hidden from people and assistive tech; bots that fill every field reveal themselves. */}
          <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
            <label>Website<input tabIndex={-1} autoComplete="off" value={website} onChange={(event) => setWebsite(event.target.value)} /></label>
          </div>

          {error && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</p>}

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={busy || isLoading}>{busy ? "Sending…" : "Send message"}</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
