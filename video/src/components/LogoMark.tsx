import React, { useId } from "react";
import { C } from "../theme";

// Same geometry as src/components/brand/logo-mark.tsx in the app.
const NIB_PATH =
  "M32 5 C34.5 12 44.5 21 44.5 32 C44.5 36.5 42 39.5 39.5 41 V46 H24.5 V41 C22 39.5 19.5 36.5 19.5 32 C19.5 21 29.5 12 32 5 Z";

const clamp = (v: number) => Math.min(1, Math.max(0, v));

/**
 * The Equal Nib mark. `reveal` (0 → 1) animates it in: the nib writes down into place,
 * then the slit and the equals sign are cut through it.
 */
export const LogoMark: React.FC<{
  size: number;
  nib?: string;
  grip?: string;
  reveal?: number;
  style?: React.CSSProperties;
}> = ({ size, nib = C.copper, grip = C.ink, reveal = 1, style }) => {
  const id = `nib-${useId().replace(/:/g, "")}`;
  const body = clamp(reveal / 0.5);
  const slit = clamp((reveal - 0.4) / 0.25);
  const bar1 = clamp((reveal - 0.5) / 0.25);
  const bar2 = clamp((reveal - 0.62) / 0.25);
  const angle = 35 - (1 - body) * 25;

  return (
    <svg width={size} height={size} viewBox="0 0 64 64" style={{ overflow: "visible", ...style }}>
      <defs>
        <mask id={id} maskUnits="userSpaceOnUse" x="-8" y="-8" width="80" height="80">
          <rect x="-8" y="-8" width="80" height="80" fill="white" />
          <g fill="black" stroke="black">
            <path d={`M32 6.5 V${6.5 + 14.5 * slit}`} strokeWidth="2" strokeLinecap="round" fill="none" opacity={slit > 0 ? 1 : 0} />
            <rect x={17} y="26" width={30 * bar1} height="4" rx="2" stroke="none" />
            <rect x={47 - 30 * bar2} y="33.5" width={30 * bar2} height="4" rx="2" stroke="none" />
            <path d="M22.5 53 H41.5" strokeWidth="1.6" fill="none" />
          </g>
        </mask>
      </defs>
      <g
        transform={`translate(0 ${(1 - body) * -10}) rotate(${angle} 32 32)`}
        opacity={body}
      >
        <g mask={`url(#${id})`}>
          <path d={NIB_PATH} fill={nib} />
          <rect x="22" y="47.5" width="20" height="11" rx="2.5" fill={grip} />
        </g>
      </g>
    </svg>
  );
};
