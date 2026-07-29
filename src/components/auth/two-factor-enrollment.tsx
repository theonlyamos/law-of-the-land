"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";
import { renderTotpQr } from "@/lib/totp-qr";
import { Check, Copy, KeyRound, Loader2, ShieldCheck, TriangleAlert } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type CandidateUser = {
  id: string;
  email: string;
  emailVerified: boolean;
  twoFactorEnabled?: boolean | null;
  role?: string | null;
};

type EnrollmentSetup = {
  qrDataUrl: string;
  manualKey: string;
  backupCodes: string[];
};

function readManualKey(totpUri: string): string {
  try {
    return new URL(totpUri).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
}

function rolesFor(user: CandidateUser | null): string[] {
  return (user?.role ?? "")
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean);
}

function resultMessage(error: unknown, fallback: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    /password/i.test(error.message)
  ) {
    return "Check your password and try again.";
  }
  return fallback;
}

export function TwoFactorEnrollment() {
  const [user, setUser] = useState<CandidateUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [setup, setSetup] = useState<EnrollmentSetup | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"id" | "codes" | null>(null);
  const [enrollmentComplete, setEnrollmentComplete] = useState(false);

  const loadSession = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const result = await authClient.getSession();
      if (result.error) throw result.error;
      setUser((result.data?.user as CandidateUser | undefined) ?? null);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  const active = enrollmentComplete || user?.twoFactorEnabled === true;
  const isSuperAdmin = useMemo(
    () => rolesFor(user).includes("super_admin"),
    [user],
  );

  const startEnrollment = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const confirmedPassword = password;
    setPassword("");
    setSubmitting(true);
    setError(null);
    try {
      const result = await authClient.twoFactor.enable({
        password: confirmedPassword,
      });
      if (result.error || !result.data) {
        setError(
          resultMessage(
            result.error,
            "We could not start authenticator setup. Try again.",
          ),
        );
        return;
      }
      const manualKey = readManualKey(result.data.totpURI);
      if (!manualKey) {
        setError("The authenticator setup response was incomplete. Start again.");
        return;
      }
      const qrDataUrl = await renderTotpQr(result.data.totpURI);
      setSetup({
        qrDataUrl,
        manualKey,
        backupCodes: result.data.backupCodes,
      });
    } catch {
      setError("We could not start authenticator setup. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const finishEnrollment = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await authClient.twoFactor.verifyTotp({
        code: code.replace(/\s+/g, ""),
        trustDevice: false,
      });
      if (result.error || !result.data) {
        setError("That verification code was not accepted. Check the time on your device and try again.");
        return;
      }
      setSetup(null);
      setCode("");
      setAcknowledged(false);
      setEnrollmentComplete(true);
      await loadSession();
    } catch {
      setError("We could not verify the code. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const copyText = async (kind: "id" | "codes", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setError("Copying was blocked by your browser. Select and copy the value manually.");
    }
  };

  if (loading) {
    return <div className="flex min-h-[40vh] items-center justify-center"><Spinner /></div>;
  }

  if (loadError) {
    return (
      <div className="container mx-auto max-w-4xl px-4 py-10">
        <Card><CardHeader><CardTitle>Account security</CardTitle><CardDescription>We could not load your account security state.</CardDescription></CardHeader><CardContent><Button variant="outline" onClick={() => void loadSession()}>Try again</Button></CardContent></Card>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="container mx-auto max-w-3xl px-4 py-10">
        <Card><CardHeader><CardTitle>Sign in to secure your account</CardTitle><CardDescription>Authenticator enrollment is available only from an authenticated account.</CardDescription></CardHeader><CardContent><Button asChild><Link href="/signin?redirect=%2Fsettings%2Fsecurity">Sign in</Link></Button></CardContent></Card>
      </div>
    );
  }

  return (
    <main className="container mx-auto max-w-5xl px-4 py-10 sm:py-14">
      <header className="grid gap-5 border-b-2 border-slate-700 pb-7 lg:grid-cols-[1fr_0.6fr] lg:items-end">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-800">Account authority</p>
          <h1 className="mt-3 font-serif text-[clamp(2.5rem,7vw,5rem)] font-semibold leading-[0.92] tracking-[-0.05em] text-slate-900">Security</h1>
        </div>
        <p className="text-sm leading-6 text-slate-600">Protect access with a time-based authenticator before an administrative role can be granted.</p>
      </header>

      <div className="mt-8 grid gap-6 lg:grid-cols-[0.72fr_1.28fr]">
        <aside className="space-y-4 border-t-4 border-amber-700 bg-amber-50 p-5 text-sm text-amber-950">
          <p className="text-xs font-semibold uppercase tracking-[0.18em]">Candidate record</p>
          <div><p className="font-semibold">{user.email}</p><p>{user.emailVerified ? "Email verified" : "Email verification required"}</p></div>
          <div aria-live="polite">
            <p className="mb-1 text-xs font-semibold uppercase tracking-[0.14em]">Better Auth user ID</p>
            <div className="flex items-center gap-2"><code className="min-w-0 flex-1 break-all bg-white/70 px-2 py-1">{user.id}</code><Button type="button" size="sm" variant="outline" aria-label={copied === "id" ? "Better Auth user ID copied" : "Copy Better Auth user ID"} onClick={() => void copyText("id", user.id)}>{copied === "id" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}</Button></div>
          </div>
        </aside>

        <section>
          <Card className="rounded-none border-slate-300 shadow-none">
            <CardHeader>
              <div className="flex items-center gap-3"><ShieldCheck className="h-6 w-6 text-amber-800" /><CardTitle>{active ? "Two-Factor is active" : "Enroll an authenticator"}</CardTitle></div>
              <CardDescription>{active ? "Your account satisfies the Two-Factor requirement for administrator roles." : "Confirm your password, scan the setup code, and verify one current authenticator code."}</CardDescription>
            </CardHeader>
            <CardContent>
              {!user.emailVerified ? (
                <div role="alert" className="flex gap-3 border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"><TriangleAlert className="mt-0.5 h-5 w-5 shrink-0" /><p>Verify your email before enrolling as an administrator. Return to sign in to request a fresh verification message.</p></div>
              ) : active ? (
                <div className="flex items-start gap-3 border-y border-emerald-300 bg-emerald-50 px-4 py-5 text-emerald-950"><Check className="mt-0.5 h-5 w-5 shrink-0" /><p>Authenticator verification is enabled. Keep your backup codes offline and never share them with an operator.</p></div>
              ) : setup ? (
                <form className="space-y-7" onSubmit={finishEnrollment}>
                  <div className="grid gap-6 sm:grid-cols-[17rem_1fr] sm:items-start">
                    <div className="border border-slate-300 bg-[#fffdf7] p-3"><Image src={setup.qrDataUrl} alt="Authenticator setup QR code" width={256} height={256} unoptimized className="h-auto w-full" /></div>
                    <div className="space-y-4 text-sm">
                      <div><h2 className="font-semibold text-slate-900">1. Add the account</h2><p className="mt-1 text-slate-600">Scan the QR code with your authenticator app. If scanning is unavailable, enter this key manually:</p><code className="mt-2 block break-all border-y border-slate-300 bg-slate-50 px-3 py-2 font-semibold tracking-[0.12em]">{setup.manualKey}</code></div>
                      <div aria-live="polite"><h2 className="font-semibold text-slate-900">2. Save the recovery codes</h2><p className="mt-1 text-slate-600">Each code works once. Store them outside this device.</p><div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 border-y border-slate-300 bg-slate-50 px-3 py-3 font-mono text-xs">{setup.backupCodes.map((backupCode) => <span key={backupCode}>{backupCode}</span>)}</div><Button type="button" size="sm" variant="outline" className="mt-2" aria-label={copied === "codes" ? "Backup codes copied" : "Copy backup codes"} onClick={() => void copyText("codes", setup.backupCodes.join("\n"))}>{copied === "codes" ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}{copied === "codes" ? "Copied" : "Copy backup codes"}</Button></div>
                    </div>
                  </div>
                  <div className="space-y-4 border-t border-slate-300 pt-5">
                    <div><label htmlFor="totp-code" className="text-sm font-semibold">6-digit verification code</label><input id="totp-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} required value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} className="mt-2 flex h-11 w-full max-w-xs border border-slate-400 bg-white px-3 text-lg tracking-[0.24em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700" /></div>
                    <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} className="mt-1 h-4 w-4" />I saved these backup codes in a secure place</label>
                    <Button type="submit" disabled={submitting || !acknowledged || code.length !== 6}>{submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Verify and finish</Button>
                  </div>
                </form>
              ) : (
                <form className="max-w-md space-y-4" onSubmit={startEnrollment}>
                  <div><label htmlFor="two-factor-password" className="text-sm font-semibold">Current password</label><input id="two-factor-password" type="password" autoComplete="current-password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} className="mt-2 flex h-11 w-full border border-slate-400 bg-white px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700" /></div>
                  <p className="text-sm text-slate-600">For administrative eligibility, use the credential account you created with email and password. OAuth-only accounts cannot be promoted.</p>
                  <Button type="submit" disabled={submitting}>{submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}Set up authenticator</Button>
                </form>
              )}
              {error && <p role="alert" className="mt-5 border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">{error}</p>}
            </CardContent>
          </Card>
        </section>
      </div>

      {active && (
        <section className="mt-10 border-t-2 border-slate-700 pt-7" aria-labelledby="bootstrap-handoff-heading">
          <div className="grid gap-6 lg:grid-cols-[0.7fr_1.3fr]">
            <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-800">Controlled transition</p><h2 id="bootstrap-handoff-heading" className="mt-2 font-serif text-3xl font-semibold text-slate-900">Administrator bootstrap handoff</h2></div>
            {isSuperAdmin ? (
              <div className="space-y-4 text-sm leading-6 text-slate-700"><p>Your Super Administrator role is active. Sign in again if it was just granted, then enable the persisted panel flag from the recovery route before enabling the deployment gate.</p><div className="flex flex-wrap gap-3"><Button asChild><Link href="/admin-recovery">Open admin recovery</Link></Button><Button asChild variant="outline"><Link href="/admin">Open administration</Link></Button></div></div>
            ) : (
              <div className="space-y-4 text-sm leading-6 text-slate-700"><p>Give only the user ID shown above to the release manager. They must follow <code className="bg-slate-100 px-1">docs/admin/bootstrap.md</code>, which binds and confirms the pre-approved isolated Convex deployment before setting the temporary allowlist or running the internal migration.</p><div className="border-y border-slate-300 bg-slate-50 p-4"><p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-600">Candidate value for the guarded runbook</p><code className="mt-2 block break-all font-semibold text-slate-900">{user.id}</code></div><p className="font-semibold text-red-800">Never run copied bootstrap commands in an unbound shell. Promotion revokes existing sessions; sign in again and complete Two-Factor verification.</p></div>
            )}
          </div>
        </section>
      )}
      <nav aria-label="Account settings" className="mt-8 flex flex-wrap gap-3 border-t border-slate-300 pt-5 text-sm"><Button asChild variant="outline"><Link href="/settings/sessions">Manage active sessions</Link></Button><Button asChild variant="ghost"><Link href="/settings/billing">Plan and billing</Link></Button></nav>
    </main>
  );
}
