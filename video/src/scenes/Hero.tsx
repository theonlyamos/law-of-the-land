import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { prog, rise, useLayout } from "../anim";
import { Eyebrow, MaskLine, Paper, SectionGlyph } from "../components/ui";
import { C, F } from "../theme";

const LINES = ["Understand", "the law", "where", "you are."];

export const Hero: React.FC = () => {
  const frame = useCurrentFrame();
  const { vertical } = useLayout();

  const underline = prog(frame, 70, 30);

  return (
    <Paper>
      <SectionGlyph
        size={vertical ? 1100 : 1150}
        style={vertical ? { right: -200, top: 300 } : { right: 120, top: -120 }}
      />
      <AbsoluteFill
        style={{
          padding: vertical ? "220px 80px" : "110px 130px",
          justifyContent: "center",
        }}
      >
        <div style={rise(frame, 0)}>
          <Eyebrow>Jurisdiction-specific legal research</Eyebrow>
        </div>
        <div
          style={{
            marginTop: 34,
            fontFamily: F.serif,
            fontSize: vertical ? 190 : 196,
            lineHeight: 0.9,
            letterSpacing: "-0.035em",
            color: C.ink,
          }}
        >
          {LINES.map((l, i) => (
            <MaskLine key={l} start={8 + i * 9} dur={34}>
              {i === 3 ? (
                <span style={{ position: "relative" }}>
                  {l}
                  <span
                    style={{
                      position: "absolute",
                      left: 0,
                      bottom: 6,
                      height: 8,
                      width: `${underline * 96}%`,
                      background: C.copperLight,
                      opacity: 0.7,
                      zIndex: -1,
                    }}
                  />
                </span>
              ) : (
                l
              )}
            </MaskLine>
          ))}
        </div>
        <p
          style={{
            ...rise(frame, 62),
            marginTop: 46,
            maxWidth: 1000,
            fontSize: vertical ? 38 : 34,
            lineHeight: 1.5,
            color: C.inkSoft,
          }}
        >
          Ask in plain language. Every answer is specific to your jurisdiction and cites the legal
          sources needed to verify it.
        </p>
      </AbsoluteFill>
    </Paper>
  );
};
