import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { ArrowUp, Check, ChevronDown, Globe, Mic, Search } from "lucide-react";
import { prog, rise, typed, useLayout } from "../anim";
import { Caret, Eyebrow, Paper, SectionGlyph } from "../components/ui";
import { Cursor } from "../components/Cursor";
import { C, F } from "../theme";

export const QUESTION = "My landlord is asking for two years' rent in advance. Is that allowed?";

const T = {
  pillClick: 46,
  pick: 74,
  micClick: 104,
  typeStart: 112,
  micStop: 214,
  sendClick: 236,
};

export const Ask: React.FC = () => {
  const frame = useCurrentFrame();
  const { vertical } = useLayout();

  const card = vertical
    ? { left: 70, top: 820, w: 940, h: 400 }
    : { left: 860, top: 330, w: 930, h: 380 };
  const pill = { x: card.left + 18, y: card.top + card.h - 18 - 66 };
  const send = { x: card.left + card.w - 18 - 66, y: card.top + card.h - 18 - 66 };
  const mic = { x: send.x - 16 - 66, y: send.y };

  const cardIn = prog(frame, 6, 30);
  const dropdown = prog(frame, T.pillClick + 2, 14) * (1 - prog(frame, T.pick + 4, 10));
  const selected = frame >= T.pick;
  const listening = frame >= T.micClick && frame < T.micStop;
  const text = typed(QUESTION, frame, T.typeStart, 22);
  const sendReady = frame >= T.micStop;
  const sendPress = frame >= T.sendClick && frame < T.sendClick + 8 ? 0.9 : 1;
  const lift = prog(frame, T.sendClick + 6, 24);

  const cursorKeys = [
    { f: 0, x: card.left + card.w * 0.6, y: card.top + card.h + 220 },
    { f: T.pillClick - 4, x: pill.x + 120, y: pill.y + 34 },
    { f: T.pillClick + 16, x: pill.x + 120, y: pill.y + 34 },
    { f: T.pick - 4, x: pill.x + 110, y: pill.y + 66 + 120 },
    { f: T.pick + 14, x: pill.x + 110, y: pill.y + 66 + 120 },
    { f: T.micClick - 4, x: mic.x + 33, y: mic.y + 36 },
    { f: T.micStop + 6, x: mic.x + 33, y: mic.y + 36 },
    { f: T.sendClick - 4, x: send.x + 33, y: send.y + 36 },
    { f: T.sendClick + 30, x: send.x + 80, y: send.y + 140 },
  ];

  return (
    <Paper>
      <SectionGlyph size={900} style={{ right: -160, top: vertical ? 1100 : -100 }} />
      <AbsoluteFill>
        <div
          style={{
            position: "absolute",
            left: vertical ? 80 : 130,
            top: vertical ? 300 : 340,
            width: vertical ? 900 : 640,
          }}
        >
          <div style={rise(frame, 0)}>
            <Eyebrow rule>01 · Ask</Eyebrow>
          </div>
          <div
            style={{
              ...rise(frame, 6),
              marginTop: 26,
              fontFamily: F.serif,
              fontSize: vertical ? 120 : 112,
              lineHeight: 0.98,
              letterSpacing: "-0.03em",
            }}
          >
            Start with a question.
          </div>
          <p style={{ ...rise(frame, 16), marginTop: 28, fontSize: vertical ? 36 : 32, lineHeight: 1.5, color: C.inkSoft }}>
            Choose the jurisdiction, then type or speak in your own words. No legal terminology needed.
          </p>
        </div>

        {/* Question card */}
        <div
          style={{
            position: "absolute",
            left: card.left,
            top: card.top,
            width: card.w,
            height: card.h,
            background: C.white,
            border: `1.5px solid ${listening ? C.brass : C.line}`,
            borderRadius: 22,
            boxShadow: `0 ${20 + lift * 30}px ${50 + lift * 40}px oklch(40% 0.05 80 / ${0.12 + lift * 0.08})`,
            opacity: cardIn,
            transform: `translateY(${(1 - cardIn) * 50 - lift * 14}px)`,
          }}
        >
          <div style={{ padding: "30px 34px", fontSize: 36, lineHeight: 1.45, color: text ? C.ink : "oklch(60% 0.02 100)" }}>
            {text || "What would you like to understand?"}
            {listening || (frame > T.typeStart && frame < T.sendClick) ? <Caret height={38} /> : null}
          </div>

          {/* Voice waveform */}
          <div
            style={{
              position: "absolute",
              left: pill.x - card.left + 300,
              top: pill.y - card.top + 14,
              display: "flex",
              gap: 6,
              alignItems: "center",
              height: 40,
              opacity: listening ? 1 : 0,
            }}
          >
            {Array.from({ length: 22 }, (_, i) => {
              const h = 8 + Math.abs(Math.sin(frame * 0.35 + i * 0.9) * Math.cos(frame * 0.13 + i)) * 32;
              return <span key={i} style={{ width: 5, height: h, borderRadius: 3, background: C.brass }} />;
            })}
            <span style={{ marginLeft: 14, fontSize: 22, color: C.brass, fontWeight: 600 }}>Listening…</span>
          </div>

          {/* Jurisdiction pill */}
          <div
            style={{
              position: "absolute",
              left: pill.x - card.left,
              top: pill.y - card.top,
              height: 66,
              padding: "0 22px",
              display: "flex",
              alignItems: "center",
              gap: 12,
              border: `1.5px solid ${selected ? C.ink : C.line}`,
              borderRadius: 12,
              fontSize: 26,
              fontWeight: 500,
              color: C.ink,
              background: selected ? C.paperLight : C.white,
            }}
          >
            <Globe size={26} strokeWidth={1.8} />
            {selected ? "Ghana" : "Choose jurisdiction"}
            <ChevronDown size={24} />
          </div>

          {/* Mic */}
          <div
            style={{
              position: "absolute",
              left: mic.x - card.left,
              top: mic.y - card.top,
              width: 66,
              height: 66,
              borderRadius: 12,
              display: "grid",
              placeItems: "center",
              background: listening ? C.brass : C.paperLight,
              color: listening ? C.white : C.ink,
              border: `1.5px solid ${listening ? C.brass : C.line}`,
              boxShadow: listening ? `0 0 0 ${8 + Math.sin(frame * 0.3) * 6}px oklch(55% 0.09 72 / 0.18)` : "none",
            }}
          >
            <Mic size={28} />
          </div>

          {/* Send */}
          <div
            style={{
              position: "absolute",
              left: send.x - card.left,
              top: send.y - card.top,
              width: 66,
              height: 66,
              borderRadius: 12,
              display: "grid",
              placeItems: "center",
              background: sendReady ? C.ink : "oklch(70% 0.03 150)",
              color: C.white,
              transform: `scale(${sendPress})`,
            }}
          >
            <ArrowUp size={30} />
          </div>

          {/* Dropdown */}
          <div
            style={{
              position: "absolute",
              left: pill.x - card.left,
              top: pill.y - card.top + 78,
              width: 430,
              background: C.white,
              border: `1.5px solid ${C.line}`,
              borderRadius: 16,
              boxShadow: "0 24px 50px oklch(40% 0.05 80 / 0.2)",
              padding: 12,
              opacity: dropdown,
              transform: `translateY(${(1 - dropdown) * -12}px)`,
              transformOrigin: "top left",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", color: "oklch(60% 0.02 100)", fontSize: 24, borderBottom: `1px solid ${C.paperDeep}` }}>
              <Search size={22} /> Search jurisdictions
            </div>
            <div
              style={{
                marginTop: 8,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "16px 14px",
                borderRadius: 10,
                background: frame > T.pick - 6 ? C.paper : "transparent",
                fontSize: 26,
                fontWeight: 600,
              }}
            >
              <span>Ghana</span>
              <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 18, letterSpacing: "0.14em", color: C.fine, fontWeight: 700 }}>
                PUBLISHED LIBRARY {frame > T.pick - 6 ? <Check size={20} /> : null}
              </span>
            </div>
          </div>
        </div>

        <div
          style={{
            position: "absolute",
            left: card.left + 4,
            top: card.top + card.h + 26,
            fontSize: 24,
            color: C.inkSoft,
            opacity: interpolate(frame, [20, 40], [0, 0.9], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          }}
        >
          {selected ? "Answers will use the reviewed legal library for Ghana." : "Choose the jurisdiction your question relates to."}
        </div>

        <Cursor keys={cursorKeys} clicks={[T.pillClick, T.pick, T.micClick, T.micStop, T.sendClick]} />
      </AbsoluteFill>
    </Paper>
  );
};
