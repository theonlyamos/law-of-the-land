export default function AdminLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="mx-auto max-w-[88rem]"
    >
      <span className="sr-only">Loading administration records…</span>
      <div
        aria-hidden="true"
        className="animate-pulse motion-reduce:animate-none"
      >
        <div className="h-3 w-40 bg-[oklch(78%_0.035_70)]" />
        <div className="mt-5 h-14 w-[min(34rem,82%)] bg-[oklch(82%_0.025_252)] sm:h-20" />
        <div className="mt-8 border-y border-[oklch(74%_0.028_78)] py-5">
          <div className="h-11 w-full bg-[oklch(89%_0.025_79)]" />
        </div>
        <div className="mt-7 space-y-1">
          {[0, 1, 2, 3].map((row) => (
            <div
              key={row}
              className="grid min-h-16 grid-cols-[0.8fr_1.2fr_0.55fr] items-center gap-5 border-b border-[oklch(81%_0.022_78)] px-4"
            >
              <span className="h-3 bg-[oklch(84%_0.022_252)]" />
              <span className="h-3 bg-[oklch(87%_0.02_252)]" />
              <span className="h-3 bg-[oklch(84%_0.022_252)]" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
