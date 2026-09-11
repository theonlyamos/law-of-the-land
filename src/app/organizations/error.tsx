"use client";
import Link from "next/link";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <div className="space-y-4 p-8">
      <h1 className="text-2xl font-semibold">
        This workspace could not be loaded
      </h1>
      <p>
        Check your membership, verified email, and two-factor sign-in, then try
        again.
      </p>
      <button className="min-h-11 border px-4" onClick={reset}>
        Try again
      </button>
      <Link className="block underline" href="/settings/security">
        Account security
      </Link>
      <Link className="block underline" href="/organizations">
        Your organizations
      </Link>
    </div>
  );
}
