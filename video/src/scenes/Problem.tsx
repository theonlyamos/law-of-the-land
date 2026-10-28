import React from "react";
import { AbsoluteFill, interpolate, random, useCurrentFrame } from "remotion";
import { prog, useLayout } from "../anim";
import { MaskLine, Paper } from "../components/ui";
import { C, F } from "../theme";

const HEADINGS = [
  "Section 25",
  "Article 18(2)",
  "Part III",
  "Schedule 2",
  "Section 4(1)(b)",
  "Regulation 12",
  "Article 33",
  "Section 71",
  "Part VII",
  "Section 9(3)",
  "First Schedule",
  "Section 112",
];

const Column: React.FC<{ seed: number; speed: number; x: number; width: number }> = ({
  seed,
  speed,
  x,
  width,
}) => {
  const frame = useCurrentFrame();
  const blocks = Array.from({ length: 14 }, (_, i) => {
    const lines = 3 + Math.floor(random(`${seed}-l-${i}`) * 5);
    return { heading: HEADINGS[Math.floor(random(`${seed}-h-${i}`) * HEADINGS.length)], lines, i };
  });
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: 0,
        width,
        transform: `translateY(${-frame * speed - 200}px)`,
      }}
    >
      {blocks.map((b) => (
        <div key={b.i} style={{ marginBottom: 42 }}>
          <div
            style={{
              fontFamily: F.serif,
              fontSize: 30,
              color: C.brassLight,
              opacity: 0.55,
              marginBottom: 14,
            }}
          >
            {b.heading}
          </div>
          {Array.from({ length: b.lines }, (_, j) => (
            <div
              key={j}
              style={{
                height: 9,
                borderRadius: 5,
                marginBottom: 13,
                background: C.paper,
                opacity: 0.13,
                width: `${j === b.lines - 1 ? 40 + random(`${seed}-${b.i}-${j}`) * 30 : 88 + random(`${seed}-${b.i}-${j}`) * 12}%`,
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
};

export const Problem: React.FC = () => {
  const frame = useCurrentFrame();
  const { vertical, width } = useLayout();
  const cols = vertical ? 4 : 7;
  const colW = width / cols - 60;

  const swap = 92;
  const first = 1 - prog(frame, swap - 10, 16);
  const blur = interpolate(frame, [0, swap, swap + 30], [2, 3, 7], { extrapolateRight: "clamp" });

  return (
    <Paper tone="ink">
      <AbsoluteFill style={{ filter: `blur(${blur}px)`, opacity: 0.9 }}>
        {Array.from({ length: cols }, (_, i) => (
          <Column key={i} seed={i + 1} speed={0.9 + (i % 3) * 0.45} x={30 + i * (colW + 60)} width={colW} />
        ))}
      </AbsoluteFill>
      <AbsoluteFill
        style={{
          background: "radial-gradient(ellipse at center, oklch(24% 0.045 150 / 0.95) 25%, transparent 75%)",
        }}
      />
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          fontFamily: F.serif,
          color: C.paper,
          fontSize: vertical ? 96 : 110,
          lineHeight: 1.04,
          letterSpacing: "-0.02em",
          padding: 80,
        }}
      >
        <div style={{ position: "absolute", opacity: first }}>
          <MaskLine start={8}>Thousands of pages.</MaskLine>
          <MaskLine start={22}>
            <span style={{ color: C.brassLight }}>Hundreds of sections.</span>
          </MaskLine>
        </div>
        <div style={{ position: "absolute" }}>
          <MaskLine start={swap + 4}>And one question</MaskLine>
          <MaskLine start={swap + 16}>
            <span style={{ fontStyle: "italic", color: C.brassLight }}>that matters to you.</span>
          </MaskLine>
        </div>
      </AbsoluteFill>
    </Paper>
  );
};
