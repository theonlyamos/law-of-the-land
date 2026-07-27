"use client";

import { authClient } from "@/lib/auth-client";
import { useEffect, useState } from "react";

export function ImpersonationBannerView({
  expiresAt,
  ending,
  error,
  onEnd,
}: {
  expiresAt: number;
  ending: boolean;
  error?: string;
  onEnd: () => void;
}) {
  return (
    <aside
      role="status"
      className="sticky top-0 z-50 border-b-2 border-[oklch(42%_0.1_64)] bg-[oklch(88%_0.09_75)] px-4 py-3 text-[oklch(27%_0.06_60)]"
    >
      <div className="mx-auto flex max-w-[100rem] flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold">
            You are viewing the site as another user
          </p>
          <p className="mt-1 text-xs">
            This session ends by{" "}
            <time dateTime={new Date(expiresAt).toISOString()}>
              {new Intl.DateTimeFormat("en", {
                hour: "numeric",
                minute: "2-digit",
                timeZoneName: "short",
              }).format(new Date(expiresAt))}
            </time>
            . Administrative writes are blocked.
          </p>
          {error ? <p role="alert" className="mt-1 text-xs font-semibold">{error}</p> : null}
        </div>
        <button
          type="button"
          disabled={ending}
          onClick={onEnd}
          className="min-h-11 shrink-0 border border-[oklch(34%_0.08_60)] bg-[oklch(96%_0.045_78)] px-4 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[oklch(30%_0.08_252)] disabled:opacity-60"
        >
          {ending ? "Ending impersonation…" : "End impersonation"}
        </button>
      </div>
    </aside>
  );
}

export function ImpersonationBanner() {
  const session = authClient.useSession();
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState("");
  const current = session.data?.session as
    | { impersonatedBy?: string | null; expiresAt?: Date | string }
    | undefined;
  const impersonatedBy = current?.impersonatedBy;
  const expiresAt = current?.expiresAt
    ? new Date(current.expiresAt).getTime()
    : Date.now() + 15 * 60_000;

  async function endImpersonation() {
    if (ending) return;
    setEnding(true);
    setError("");
    try {
      const result = await authClient.admin.stopImpersonating();
      if (result.error) {
        throw new Error(result.error.message);
      }
      window.location.assign("/admin");
    } catch {
      setEnding(false);
      setError(
        "Impersonation could not be ended. Refresh the page and try again.",
      );
    }
  }

  useEffect(() => {
    if (!impersonatedBy || !Number.isFinite(expiresAt)) return;
    const remaining = Math.max(0, expiresAt - Date.now());
    const timeout = window.setTimeout(() => {
      void endImpersonation();
    }, Math.min(remaining, 2_147_483_647));
    return () => window.clearTimeout(timeout);
  }, [expiresAt, impersonatedBy]);

  if (!impersonatedBy) return null;
  return (
    <ImpersonationBannerView
      expiresAt={expiresAt}
      ending={ending}
      error={error}
      onEnd={() => void endImpersonation()}
    />
  );
}
