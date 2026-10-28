import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { prog } from "../anim";
import { C, F } from "../theme";

const GRAIN =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.35 0 0 0 0 0.28 0 0 0 0 0.15 0 0 0 0.07 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")";

/** Warm paper background used across the app's landing page. */
export const Paper: React.FC<{ tone?: "paper" | "light" | "ink"; children?: React.ReactNode }> = ({
  tone = "paper",
  children,
}) => {
  const bg = tone === "ink" ? C.ink : tone === "light" ? C.paperLight : C.paper;
  const vignette =
    tone === "ink"
      ? "radial-gradient(ellipse at 50% 40%, transparent 30%, oklch(14% 0.03 150 / 0.75) 100%)"
      : "radial-gradient(ellipse at 50% 40%, transparent 45%, oklch(80% 0.05 79 / 0.35) 100%)";
  return (
    <AbsoluteFill style={{ background: bg, fontFamily: F.sans, color: tone === "ink" ? C.paper : C.ink }}>
      <AbsoluteFill style={{ backgroundImage: GRAIN, opacity: tone === "ink" ? 0.5 : 1 }} />
      <AbsoluteFill style={{ background: vignette }} />
      {children}
    </AbsoluteFill>
  );
};

/** Small uppercase brass label, like the site's eyebrows. */
export const Eyebrow: React.FC<{
  children: React.ReactNode;
  style?: React.CSSProperties;
  rule?: boolean;
  color?: string;
}> = ({ children, style, rule, color = C.brass }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 18,
      fontFamily: F.sans,
      fontWeight: 700,
      fontSize: 22,
      letterSpacing: "0.2em",
      textTransform: "uppercase",
      color,
      ...style,
    }}
  >
    {rule ? <span style={{ width: 44, height: 2, background: color }} /> : null}
    {children}
  </div>
);

/** Large serif § in the background, slowly drifting. */
export const SectionGlyph: React.FC<{ size?: number; style?: React.CSSProperties; color?: string }> = ({
  size = 900,
  style,
  color = C.paperDeep,
}) => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        position: "absolute",
        fontFamily: F.serif,
        fontSize: size,
        lineHeight: 1,
        color,
        transform: `translateY(${interpolate(frame, [0, 300], [20, -40])}px) rotate(${interpolate(
          frame,
          [0, 300],
          [-3, 3],
        )}deg)`,
        ...style,
      }}
    >
      §
    </div>
  );
};

export const Logo: React.FC<{ width: number; style?: React.CSSProperties }> = ({ width, style }) => (
  <Img
    src={staticFile("logo.png")}
    style={{ width, height: "auto", filter: "saturate(0.78) contrast(1.05)", ...style }}
  />
);

/** Line of text revealed upward from behind a mask. */
export const MaskLine: React.FC<{
  start: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
  dur?: number;
}> = ({ start, children, style, dur = 30 }) => {
  const frame = useCurrentFrame();
  const p = prog(frame, start, dur);
  return (
    <div style={{ overflow: "hidden", paddingBottom: "0.12em", marginBottom: "-0.12em", ...style }}>
      <div style={{ transform: `translateY(${(1 - p) * 110}%)`, opacity: Math.min(1, p * 1.6) }}>{children}</div>
    </div>
  );
};

/** Grey placeholder text line, as used in the site's illustrative layouts. */
export const Bar: React.FC<{ w: number | string; h?: number; color?: string; style?: React.CSSProperties }> = ({
  w,
  h = 10,
  color = C.paperDeep,
  style,
}) => <div style={{ width: w, height: h, borderRadius: h / 2, background: color, ...style }} />;

export const StatusDot: React.FC<{ color: string; size?: number }> = ({ color, size = 12 }) => (
  <span style={{ display: "inline-block", width: size, height: size, borderRadius: "50%", background: color }} />
);

export const Footnote: React.FC<{ children: React.ReactNode; start?: number; color?: string }> = ({
  children,
  start = 20,
  color = C.inkSoft,
}) => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 36,
        textAlign: "center",
        fontSize: 20,
        color,
        opacity: prog(frame, start, 20) * 0.8,
        fontFamily: F.sans,
      }}
    >
      {children}
    </div>
  );
};

/** Blinking text caret. */
export const Caret: React.FC<{ color?: string; height?: number }> = ({ color = C.ink, height = 34 }) => {
  const frame = useCurrentFrame();
  const on = Math.floor(frame / 15) % 2 === 0;
  return (
    <span
      style={{
        display: "inline-block",
        width: 3,
        height,
        marginLeft: 3,
        verticalAlign: "text-bottom",
        background: color,
        opacity: on ? 1 : 0,
      }}
    />
  );
};
