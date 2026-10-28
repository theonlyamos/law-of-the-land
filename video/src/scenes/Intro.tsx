import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { prog, useLayout } from "../anim";
import { Eyebrow, Paper } from "../components/ui";
import { LogoMark } from "../components/LogoMark";
import { C, F } from "../theme";

const TITLE = "Law of the Land";

export const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const { vertical } = useLayout();

  const logoP = prog(frame, 2, 56);
  const ruleP = prog(frame, 30, 36);
  const scale = interpolate(frame, [0, 150], [1.04, 1]);

  return (
    <Paper tone="light">
      <AbsoluteFill
        style={{ alignItems: "center", justifyContent: "center", transform: `scale(${scale})` }}
      >
        <LogoMark size={vertical ? 380 : 330} reveal={logoP} style={{ margin: "-60px 0 -50px" }} />

        <div
          style={{
            marginTop: 40,
            display: "flex",
            fontFamily: F.serif,
            fontSize: vertical ? 132 : 150,
            letterSpacing: "-0.02em",
            color: C.ink,
            lineHeight: 1,
          }}
        >
          {TITLE.split("").map((ch, i) => {
            const p = prog(frame, 22 + i * 2, 28);
            return (
              <span
                key={i}
                style={{
                  display: "inline-block",
                  whiteSpace: "pre",
                  opacity: p,
                  transform: `translateY(${(1 - p) * 40}px)`,
                  filter: `blur(${(1 - p) * 8}px)`,
                }}
              >
                {ch}
              </span>
            );
          })}
        </div>

        <div
          style={{
            marginTop: 40,
            height: 2,
            width: 520 * ruleP,
            background: C.copper,
          }}
        />

        <Eyebrow
          style={{
            marginTop: 34,
            fontSize: vertical ? 22 : 24,
            opacity: prog(frame, 48, 30),
            letterSpacing: `${interpolate(prog(frame, 48, 50), [0, 1], [0.5, 0.24])}em`,
          }}
        >
          Jurisdiction-specific legal research
        </Eyebrow>
      </AbsoluteFill>
    </Paper>
  );
};
