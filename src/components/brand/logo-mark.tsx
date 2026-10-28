import { useId } from "react";

// The Equal Nib: a fountain pen nib at a writing angle with an equals sign cut through it.
// The nib uses the brand colour and the grip follows the text colour, so the mark works in light and dark mode.
export const NIB_PATH =
  "M32 5 C34.5 12 44.5 21 44.5 32 C44.5 36.5 42 39.5 39.5 41 V46 H24.5 V41 C22 39.5 19.5 36.5 19.5 32 C19.5 21 29.5 12 32 5 Z";

type LogoMarkProps = {
  className?: string;
  /** Accessible name. Leave empty when the mark sits next to visible "Law of the Land" text. */
  title?: string;
};

export function LogoMark({ className, title }: LogoMarkProps) {
  const maskId = `lotl-mark-${useId().replace(/:/g, "")}`;
  const labelled = Boolean(title);

  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      data-logo-mark=""
      role={labelled ? "img" : undefined}
      aria-label={labelled ? title : undefined}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="-8" y="-8" width="80" height="80">
          <rect x="-8" y="-8" width="80" height="80" fill="white" />
          <g fill="black" stroke="black">
            <path d="M32 6.5 V21" strokeWidth="2" strokeLinecap="round" fill="none" />
            <rect x="17" y="26" width="30" height="4" rx="2" stroke="none" />
            <rect x="17" y="33.5" width="30" height="4" rx="2" stroke="none" />
            <path d="M22.5 53 H41.5" strokeWidth="1.6" fill="none" />
          </g>
        </mask>
      </defs>
      {/* Mask coordinates follow the rotated group, so the cut-outs line up with the nib. */}
      <g transform="rotate(35 32 32)">
        <g mask={`url(#${maskId})`}>
          <path d={NIB_PATH} fill="var(--logo-nib, hsl(var(--brand)))" />
          <rect x="22" y="47.5" width="20" height="11" rx="2.5" fill="currentColor" />
        </g>
      </g>
    </svg>
  );
}
