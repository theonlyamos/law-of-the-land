import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { BookOpen, Scale } from "lucide-react";
import { prog, rise, useLayout } from "../anim";
import { Bar, Eyebrow, Footnote, Paper } from "../components/ui";
import { C, F } from "../theme";
import { QUESTION } from "./Ask";

type Tok = { w: string } | { cite: number } | { br: true };

const toks = (s: string): Tok[] =>
  s.split(/(\[\d\]|\n)/).flatMap((part): Tok[] => {
    if (part === "\n") return [{ br: true }];
    const m = part.match(/^\[(\d)\]$/);
    if (m) return [{ cite: Number(m[1]) }];
    return part
      .split(" ")
      .filter(Boolean)
      .map((w) => ({ w }));
  });

const ANSWER = toks(
  "No, not for that amount. Under Ghana's Rent Act, a landlord may not demand or accept more than six months' rent in advance. [1]\nDemanding advance rent beyond that limit is treated as an offence under the Act. [1] You can raise it with your local Rent Control office before you pay anything.",
);

const STREAM_START = 66;
const WPS = 9; // words per second

const CiteChip: React.FC<{ n: number; pulse: number }> = ({ n, pulse }) => (
  <span
    style={{
      display: "inline-grid",
      placeItems: "center",
      minWidth: 40,
      height: 40,
      margin: "0 6px",
      padding: "0 8px",
      borderRadius: 8,
      fontSize: 24,
      fontWeight: 700,
      fontFamily: F.sans,
      color: C.white,
      background: C.brass,
      verticalAlign: "middle",
      transform: `scale(${1 + pulse * 0.2})`,
      boxShadow: pulse > 0 ? `0 0 0 ${pulse * 10}px oklch(55% 0.09 72 / 0.2)` : "none",
    }}
  >
    {n}
  </span>
);

export const Answer: React.FC = () => {
  const frame = useCurrentFrame();
  const { vertical } = useLayout();

  const visible = Math.max(0, Math.floor(((frame - STREAM_START) / 30) * WPS));
  const firstCiteIdx = ANSWER.findIndex((t) => "cite" in t);
  const citeShown = visible > firstCiteIdx;
  const citeFrame = STREAM_START + Math.ceil(((firstCiteIdx + 1) / WPS) * 30);
  const panel = prog(frame, citeFrame, 30);
  const highlight = prog(frame, citeFrame + 28, 34);
  const pulse = interpolate(frame, [citeFrame, citeFrame + 8, citeFrame + 20], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const searching = frame >= 20 && frame < STREAM_START;
  const searchP = prog(frame, 22, 44);

  const chatW = vertical ? 940 : 1010;

  return (
    <Paper tone="light">
      <AbsoluteFill style={{ padding: vertical ? "150px 70px" : "150px 120px" }}>
        <div style={rise(frame, 0)}>
          <Eyebrow rule>02 · Understand</Eyebrow>
        </div>

        <div style={{ display: "flex", flexDirection: vertical ? "column" : "row", gap: vertical ? 50 : 80, marginTop: 40 }}>
          {/* Chat column */}
          <div style={{ width: chatW }}>
            <div style={{ display: "flex", justifyContent: "flex-end", ...rise(frame, 4) }}>
              <div
                style={{
                  maxWidth: 820,
                  background: C.ink,
                  color: C.paperLight,
                  padding: "28px 36px",
                  borderRadius: "26px 26px 6px 26px",
                  fontSize: 38,
                  lineHeight: 1.45,
                }}
              >
                {QUESTION}
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12, ...rise(frame, 10) }}>
              <span style={{ fontSize: 22, fontWeight: 700, letterSpacing: "0.16em", color: C.brass }}>GHANA</span>
            </div>

            <div style={{ marginTop: 34, display: "flex", gap: 22 }}>
              <div
                style={{
                  ...rise(frame, 16),
                  flex: "0 0 auto",
                  width: 68,
                  height: 68,
                  borderRadius: 14,
                  display: "grid",
                  placeItems: "center",
                  background: C.paper,
                  border: `1.5px solid ${C.line}`,
                  color: C.brass,
                }}
              >
                <Scale size={36} />
              </div>
              <div style={{ flex: 1 }}>
                {searching ? (
                  <div style={{ ...rise(frame, 20, 12), paddingTop: 12 }}>
                    <div style={{ fontSize: 32, color: C.inkSoft }}>
                      Searching the published legal library for Ghana…
                    </div>
                    <div style={{ marginTop: 18, height: 6, width: 520, borderRadius: 3, background: C.paperDeep, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${searchP * 100}%`, background: C.brass }} />
                    </div>
                  </div>
                ) : null}
                <div style={{ fontSize: vertical ? 40 : 40, lineHeight: 1.55, color: C.ink, paddingTop: 6 }}>
                  {ANSWER.map((t, i) => {
                    if (i >= visible) return null;
                    if ("br" in t) return <div key={i} style={{ height: 22 }} />;
                    if ("cite" in t) return <CiteChip key={i} n={t.cite} pulse={i === firstCiteIdx ? pulse : 0} />;
                    const p = prog(frame, STREAM_START + (i / WPS) * 30, 8);
                    return (
                      <span key={i} style={{ opacity: p, fontWeight: i < 6 ? 700 : 400 }}>
                        {t.w}{" "}
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Source panel */}
          <div
            style={{
              flex: 1,
              opacity: panel,
              transform: vertical ? `translateY(${(1 - panel) * 60}px)` : `translateX(${(1 - panel) * 80}px)`,
              visibility: citeShown ? "visible" : "hidden",
            }}
          >
            <div
              style={{
                background: C.paper,
                border: `1.5px solid ${C.line}`,
                borderRadius: 20,
                padding: 44,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <CiteChip n={1} pulse={0} />
                <Eyebrow style={{ fontSize: 19 }}>Source</Eyebrow>
              </div>
              <div style={{ marginTop: 22, fontFamily: F.serif, fontSize: 64, lineHeight: 1.02 }}>
                Rent Act, 1963 (Act 220)
              </div>
              <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10, fontSize: 28, fontWeight: 600, color: C.inkSoft }}>
                <BookOpen size={24} /> Section 25 · Rent advance
              </div>
              <div style={{ marginTop: 30, borderLeft: `4px solid ${C.brass}`, paddingLeft: 24 }}>
                <Bar w="92%" style={{ marginBottom: 16 }} />
                <Bar w="80%" style={{ marginBottom: 18 }} />
                <div style={{ position: "relative", display: "inline-block", fontSize: 32, fontWeight: 600, color: C.ink, marginBottom: 18 }}>
                  <span
                    style={{
                      position: "absolute",
                      left: -6,
                      top: 2,
                      bottom: 2,
                      width: `calc(${highlight * 100}% + 12px)`,
                      background: "oklch(85% 0.09 85 / 0.7)",
                      borderRadius: 6,
                      zIndex: 0,
                    }}
                  />
                  <span style={{ position: "relative" }}>advance rent … not exceeding six months</span>
                </div>
                <Bar w="88%" style={{ marginBottom: 16 }} />
                <Bar w="56%" />
              </div>
              <div
                style={{
                  marginTop: 30,
                  paddingTop: 22,
                  borderTop: `1px solid ${C.line}`,
                  fontSize: 26,
                  color: C.inkSoft,
                  opacity: prog(frame, citeFrame + 50, 20),
                }}
              >
                Open the provision to read it in full and verify the answer.
              </div>
            </div>
          </div>
        </div>
      </AbsoluteFill>
      <Footnote start={60}>Illustrative example. General legal information, not legal advice.</Footnote>
    </Paper>
  );
};
