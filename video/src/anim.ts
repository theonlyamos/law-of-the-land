import { Easing, interpolate, useVideoConfig } from "remotion";

export const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
export const easeInOut = Easing.bezier(0.65, 0, 0.35, 1);

/** 0 → 1 progress between start and start + dur, clamped and eased. */
export const prog = (frame: number, start: number, dur = 24, easing = easeOut) =>
  interpolate(frame, [start, start + dur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing,
  });

/** Fade + rise entrance style. */
export const rise = (frame: number, start: number, dist = 28, dur = 26): React.CSSProperties => {
  const p = prog(frame, start, dur);
  return { opacity: p, transform: `translateY(${(1 - p) * dist}px)` };
};

/** Characters of text visible after typing from `start` at `cps` chars per second. */
export const typed = (text: string, frame: number, start: number, cps = 28, fps = 30) => {
  const n = Math.max(0, Math.floor(((frame - start) / fps) * cps));
  return text.slice(0, n);
};

export const useLayout = () => {
  const { width, height } = useVideoConfig();
  const vertical = height > width;
  return { vertical, width, height };
};
