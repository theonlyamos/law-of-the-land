import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { CheckCircle2, Eye, FileUp, MessageSquare } from "lucide-react";
import { easeInOut, prog, rise, typed, useLayout } from "../anim";
import { Bar, Eyebrow, Paper } from "../components/ui";
import { C, F } from "../theme";

const STAGES = [
  { label: "Uploaded", Icon: FileUp },
  { label: "In review", Icon: Eye },
  { label: "Published", Icon: CheckCircle2 },
];

const DOCS = [
  { name: "Labour Act, 2003", t: 26 },
  { name: "Staff handbook", t: 44 },
  { name: "Data Protection Act", t: 62 },
];

const SNIPPET = '<script src="https://lawoftheland.vercel.app/widget.js" data-embed-id="your-org"></script>';

export const Organisations: React.FC = () => {
  const frame = useCurrentFrame();
  const { vertical } = useLayout();

  const colW = vertical ? 300 : 250;
  const gap = vertical ? 20 : 16;

  const widgetOpen = prog(frame, 168, 22);
  const snippet = typed(SNIPPET, frame, 110, 70);

  return (
    <Paper>
      <AbsoluteFill style={{ padding: vertical ? "120px 60px" : "90px 130px", justifyContent: vertical ? "center" : undefined }}>
        <div style={rise(frame, 0)}>
          <Eyebrow rule>For organisations</Eyebrow>
        </div>
        <div
          style={{
            ...rise(frame, 6),
            marginTop: 22,
            fontFamily: F.serif,
            fontSize: vertical ? 92 : 84,
            lineHeight: 1,
            letterSpacing: "-0.03em",
            maxWidth: 1500,
          }}
        >
          Review and publish your own library. Then answer from it anywhere.
        </div>

        <div
          style={{
            marginTop: vertical ? 60 : 64,
            display: "flex",
            flexDirection: vertical ? "column" : "row",
            gap: vertical ? 60 : 70,
          }}
        >
          {/* Pipeline */}
          <div style={{ position: "relative", width: colW * 3 + gap * 2, height: 470, ...rise(frame, 12) }}>
            {STAGES.map((s, i) => (
              <div
                key={s.label}
                style={{
                  position: "absolute",
                  left: i * (colW + gap),
                  top: 0,
                  width: colW,
                  height: 470,
                  borderRadius: 16,
                  border: `1.5px dashed ${C.line}`,
                  background: i === 2 ? "oklch(94% 0.03 150 / 0.5)" : "oklch(98% 0.014 84 / 0.6)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "20px 20px 0", fontSize: 18, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: i === 2 ? C.fine : C.brass }}>
                  <s.Icon size={22} /> {s.label}
                </div>
              </div>
            ))}
            {DOCS.map((d, i) => {
              const toReview = prog(frame, d.t + 20, 26, easeInOut);
              const toPublish = prog(frame, d.t + 70, 26, easeInOut);
              const x = (toReview + toPublish) * (colW + gap) + 14;
              const appear = prog(frame, d.t, 16);
              const published = toPublish > 0.95;
              return (
                <div
                  key={d.name}
                  style={{
                    position: "absolute",
                    left: x,
                    top: 76 + i * 128,
                    width: colW - 28,
                    padding: "16px 18px",
                    background: C.white,
                    borderRadius: 12,
                    border: `1.5px solid ${published ? C.fine : C.line}`,
                    boxShadow: "0 10px 24px oklch(40% 0.05 80 / 0.12)",
                    opacity: appear,
                    transform: `translateY(${(1 - appear) * 20}px) rotate(${Math.sin((toReview + toPublish) * Math.PI) * 2}deg)`,
                  }}
                >
                  <div style={{ fontSize: 24, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.name}</div>
                  <Bar w="86%" h={7} style={{ marginTop: 12 }} />
                  <Bar w="54%" h={7} style={{ marginTop: 8 }} />
                </div>
              );
            })}
          </div>

          {/* Website with widget */}
          <div style={{ flex: 1, position: "relative", ...rise(frame, 70, 40) }}>
            <div
              style={{
                height: vertical ? 620 : 470,
                background: C.white,
                border: `1.5px solid ${C.line}`,
                borderRadius: 16,
                overflow: "hidden",
                position: "relative",
                boxShadow: "0 24px 50px oklch(40% 0.05 80 / 0.15)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 18px", borderBottom: `1px solid ${C.paperDeep}`, background: C.paperLight }}>
                {[0, 1, 2].map((k) => (
                  <span key={k} style={{ width: 13, height: 13, borderRadius: "50%", background: C.paperDeep }} />
                ))}
                <div style={{ marginLeft: 16, flex: 1, height: 30, borderRadius: 8, background: C.paper, fontSize: 17, color: C.inkSoft, display: "flex", alignItems: "center", paddingLeft: 14 }}>
                  your-organisation.com/help
                </div>
              </div>
              <div style={{ padding: 30 }}>
                <Bar w={260} h={22} color={C.paperDeep} />
                <Bar w="80%" h={10} style={{ marginTop: 26 }} />
                <Bar w="72%" h={10} style={{ marginTop: 14 }} />
                <Bar w="76%" h={10} style={{ marginTop: 14 }} />
                <div style={{ display: "flex", gap: 16, marginTop: 30 }}>
                  <div style={{ width: 160, height: 110, borderRadius: 10, background: C.paper }} />
                  <div style={{ width: 160, height: 110, borderRadius: 10, background: C.paper }} />
                </div>
              </div>

              {/* Widget panel */}
              <div
                style={{
                  position: "absolute",
                  right: 22,
                  bottom: 88,
                  width: 400,
                  background: C.paperLight,
                  border: `1.5px solid ${C.line}`,
                  borderRadius: 16,
                  boxShadow: "0 24px 50px oklch(30% 0.05 80 / 0.25)",
                  overflow: "hidden",
                  opacity: widgetOpen,
                  transform: `translateY(${(1 - widgetOpen) * 30}px) scale(${0.92 + widgetOpen * 0.08})`,
                  transformOrigin: "bottom right",
                }}
              >
                <div style={{ background: C.ink, color: C.paperLight, padding: "14px 18px", fontSize: 19, fontWeight: 600 }}>
                  Ask about our policies
                </div>
                <div style={{ padding: 16, fontSize: 18, lineHeight: 1.45 }}>
                  <div style={{ marginLeft: "auto", width: "fit-content", maxWidth: 300, background: C.paperDeep, padding: "10px 14px", borderRadius: 12 }}>
                    How much annual leave do I get?
                  </div>
                  <div style={{ marginTop: 12, opacity: prog(frame, 196, 16) }}>
                    Your contract and the Labour Act both apply…
                    <span style={{ marginLeft: 6, display: "inline-grid", placeItems: "center", width: 24, height: 24, borderRadius: 6, background: C.brass, color: C.white, fontSize: 14, fontWeight: 700 }}>
                      1
                    </span>
                  </div>
                </div>
              </div>

              {/* Launcher */}
              <div
                style={{
                  position: "absolute",
                  right: 22,
                  bottom: 22,
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  height: 52,
                  padding: "0 20px",
                  borderRadius: 26,
                  background: C.ink,
                  color: C.paperLight,
                  fontSize: 19,
                  fontWeight: 600,
                  opacity: prog(frame, 140, 14),
                  transform: `scale(${interpolate(frame, [140, 150, 158], [0.6, 1.08, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })})`,
                }}
              >
                <MessageSquare size={20} /> Ask a question
              </div>
            </div>

            <div
              style={{
                marginTop: 18,
                padding: "14px 18px",
                borderRadius: 10,
                background: C.ink,
                color: C.brassLight,
                fontFamily: F.mono,
                fontSize: vertical ? 17 : 16,
                minHeight: 50,
                opacity: prog(frame, 104, 10),
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {snippet}
            </div>
          </div>
        </div>
      </AbsoluteFill>
    </Paper>
  );
};
