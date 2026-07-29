export function LegalInformationNotice({ className }: { className?: string }) {
  return (
    <aside
      className={className}
      aria-label="Legal information disclaimer"
      id="legal-information-notice"
    >
      <span
        aria-hidden
        className="grid size-8 shrink-0 place-items-center rounded-full border border-current font-serif text-sm"
      >
        i
      </span>
      <strong className="leading-8">Legal information, not legal advice</strong>
      <p className="m-0 text-sm leading-relaxed opacity-85">
        Law of the Land helps you understand published legal sources. It cannot assess every fact
        in your situation or replace advice from a qualified legal professional.
      </p>
    </aside>
  );
}
