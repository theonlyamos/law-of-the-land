import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { FileSearch, History, Mic, Quote, ShieldCheck, Users } from "lucide-react";
import { prog, rise, useLayout } from "../anim";
import { Eyebrow, MaskLine, Paper } from "../components/ui";
import { C, F } from "../theme";

const FEATURES = [
  { Icon: Quote, title: "Cited answers", body: "Material claims point back to the provision behind them." },
  { Icon: Mic, title: "Voice input", body: "Ask out loud when typing is not convenient." },
  { Icon: FileSearch, title: "Document review", body: "PDF, Word, text or photo, up to 100 pages." },
  { Icon: History, title: "Saved research", body: "Every thread keeps its jurisdiction and history." },
  { Icon: Users, title: "Team workspaces", body: "Organisations manage members and their library." },
  { Icon: ShieldCheck, title: "Secure accounts", body: "Email, Google or GitHub sign-in with two-factor." },
];

export const Features: React.FC = () => {
  const frame = useCurrentFrame();
  const { vertical } = useLayout();
  const cols = vertical ? 2 : 3;

  return (
    <Paper tone="ink">
      <AbsoluteFill style={{ padding: vertical ? "120px 70px" : "100px 130px", justifyContent: vertical ? "center" : undefined }}>
        <div style={rise(frame, 0)}>
          <Eyebrow rule color={C.copperLight}>
            Built for trust
          </Eyebrow>
        </div>
        <div
          style={{
            marginTop: 24,
            fontFamily: F.serif,
            fontSize: vertical ? 100 : 96,
            lineHeight: 1,
            letterSpacing: "-0.03em",
            color: C.paperLight,
          }}
        >
          <MaskLine start={4}>Everything you need to</MaskLine>
          <MaskLine start={12}>
            <span style={{ fontStyle: "italic", color: C.copperLight }}>research with confidence.</span>
          </MaskLine>
        </div>
        <div
          style={{
            marginTop: vertical ? 70 : 70,
            display: "grid",
            gridTemplateColumns: `repeat(${cols}, 1fr)`,
            gap: vertical ? 22 : 26,
          }}
        >
          {FEATURES.map((f, i) => {
            const start = 26 + i * 8;
            const glow = prog(frame, start + 10, 20) * (1 - prog(frame, start + 40, 30));
            return (
              <div
                key={f.title}
                style={{
                  ...rise(frame, start, 30),
                  padding: vertical ? "30px 28px" : "30px 32px",
                  borderRadius: 18,
                  border: `1.5px solid rgb(239 154 92 / ${0.2 + glow * 0.6})`,
                  background: `oklch(30% 0.045 150 / ${0.6 + glow * 0.3})`,
                }}
              >
                <div
                  style={{
                    width: 58,
                    height: 58,
                    borderRadius: 14,
                    display: "grid",
                    placeItems: "center",
                    background: "rgb(239 154 92 / 0.14)",
                    color: C.copperLight,
                  }}
                >
                  <f.Icon size={30} strokeWidth={1.7} />
                </div>
                <div style={{ marginTop: 20, fontSize: vertical ? 32 : 30, fontWeight: 700, color: C.paperLight }}>{f.title}</div>
                <div style={{ marginTop: 8, fontSize: vertical ? 25 : 24, lineHeight: 1.45, color: "oklch(82% 0.02 100)" }}>{f.body}</div>
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
    </Paper>
  );
};
