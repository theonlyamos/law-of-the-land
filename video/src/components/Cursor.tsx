import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { easeInOut } from "../anim";

type Key = { f: number; x: number; y: number };

/** Pointer that glides between keyframes and dips on click frames. */
export const Cursor: React.FC<{ keys: Key[]; clicks?: number[]; opacity?: number }> = ({
  keys,
  clicks = [],
  opacity = 1,
}) => {
  const frame = useCurrentFrame();
  const fs = keys.map((k) => k.f);
  const x = interpolate(frame, fs, keys.map((k) => k.x), {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeInOut,
  });
  const y = interpolate(frame, fs, keys.map((k) => k.y), {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeInOut,
  });
  const press = clicks.reduce((acc, c) => {
    const d = frame - c;
    return d >= 0 && d < 10 ? Math.max(acc, 1 - Math.abs(d - 3) / 7) : acc;
  }, 0);
  const ring = clicks
    .map((c) => frame - c)
    .filter((d) => d >= 0 && d < 20)
    .map((d) => d / 20)[0];

  return (
    <div style={{ position: "absolute", left: x, top: y, pointerEvents: "none", opacity, zIndex: 50 }}>
      {ring !== undefined ? (
        <div
          style={{
            position: "absolute",
            left: -26 * (0.4 + ring),
            top: -26 * (0.4 + ring),
            width: 52 * (0.4 + ring),
            height: 52 * (0.4 + ring),
            borderRadius: "50%",
            border: "3px solid oklch(55% 0.09 72)",
            opacity: 1 - ring,
          }}
        />
      ) : null}
      <svg
        width="38"
        height="38"
        viewBox="0 0 24 24"
        style={{ transform: `scale(${1 - press * 0.18})`, transformOrigin: "0 0", filter: "drop-shadow(0 4px 6px rgba(0,0,0,0.25))" }}
      >
        <path d="M4 2 L4 19 L8.5 14.8 L11.4 21.5 L14.3 20.3 L11.4 13.7 L17.5 13.7 Z" fill="#14231a" stroke="#fff" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    </div>
  );
};
