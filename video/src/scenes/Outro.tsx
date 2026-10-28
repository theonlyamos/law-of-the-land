import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { ArrowRight } from "lucide-react";
import { prog, rise, useLayout } from "../anim";
import { Eyebrow, Logo, MaskLine, Paper, SectionGlyph } from "../components/ui";
import { C, F } from "../theme";

export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const { vertical } = useLayout();
  const btn = prog(frame, 44, 24);
  const shine = interpolate(frame, [70, 110], [-30, 130], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <Paper tone="light">
      <SectionGlyph size={1300} style={{ left: vertical ? -300 : -180, top: vertical ? 500 : -260 }} color="oklch(93% 0.03 82)" />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", textAlign: "center", padding: 80 }}>
        <div style={rise(frame, 0, 20)}>
          <Logo width={vertical ? 240 : 190} />
        </div>
        <div
          style={{
            marginTop: 34,
            fontFamily: F.serif,
            fontSize: vertical ? 110 : 120,
            lineHeight: 1,
            letterSpacing: "-0.03em",
            color: C.ink,
          }}
        >
          <MaskLine start={8}>Begin with the jurisdiction</MaskLine>
          <MaskLine start={18}>
            <span style={{ fontStyle: "italic", color: C.brass }}>whose law applies.</span>
          </MaskLine>
        </div>
        <div
          style={{
            marginTop: 56,
            position: "relative",
            overflow: "hidden",
            display: "flex",
            alignItems: "center",
            gap: 16,
            padding: "26px 44px",
            background: C.ink,
            color: C.paperLight,
            fontSize: 32,
            fontWeight: 700,
            borderRadius: 8,
            opacity: btn,
            transform: `translateY(${(1 - btn) * 20}px) scale(${0.96 + btn * 0.04})`,
          }}
        >
          Ask your first question <ArrowRight size={32} />
          <span
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: `${shine}%`,
              width: 80,
              background: "linear-gradient(90deg, transparent, oklch(100% 0 0 / 0.25), transparent)",
              transform: "skewX(-20deg)",
            }}
          />
        </div>
        <div style={{ ...rise(frame, 60), marginTop: 40 }}>
          <Eyebrow style={{ fontSize: 26, letterSpacing: "0.12em", textTransform: "none" }}>
            lawoftheland.vercel.app
          </Eyebrow>
        </div>
        <div style={{ ...rise(frame, 72), marginTop: 18, fontSize: 22, color: C.inkSoft }}>
          Free account · General legal information, not legal advice
        </div>
      </AbsoluteFill>
    </Paper>
  );
};
