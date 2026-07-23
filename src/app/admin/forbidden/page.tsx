import Link from "next/link";

export default function AdminForbiddenPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-[oklch(94%_0.015_82)] px-5 py-12 text-[oklch(24%_0.035_252)]">
      <section className="w-full max-w-2xl border-t-4 border-[oklch(55%_0.1_68)] bg-[oklch(97%_0.012_82)] px-6 py-10 shadow-[0_1.5rem_4rem_oklch(30%_0.03_252/0.12)] sm:px-10 sm:py-14">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[oklch(43%_0.065_67)]">
          Administration · access boundary
        </p>
        <h1 className="mt-4 text-balance text-[clamp(2.25rem,8vw,4.5rem)] font-semibold leading-[0.96] tracking-[-0.055em]">
          This control room is restricted.
        </h1>
        <p className="mt-6 max-w-[58ch] text-base leading-7 text-[oklch(42%_0.035_252)]">
          Your current session does not have assured administrative access, or
          site-wide administration is not enabled in this environment. Sign in
          with an enrolled administrator account or contact a super administrator.
        </p>
        <div className="mt-9 flex flex-wrap gap-x-5 gap-y-2">
          <Link
            href="/signin?redirect=%2Fadmin"
            className="inline-flex min-h-11 items-center bg-[oklch(28%_0.055_252)] px-5 text-sm font-semibold text-[oklch(97%_0.012_82)] transition-colors duration-150 hover:bg-[oklch(23%_0.055_252)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
          >
            Sign in as an administrator
          </Link>
          <Link
            href="/new"
            className="inline-flex min-h-11 items-center px-2 text-sm font-semibold underline decoration-[oklch(58%_0.1_68)] decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
          >
            Return to the public site
          </Link>
        </div>
      </section>
    </main>
  );
}
