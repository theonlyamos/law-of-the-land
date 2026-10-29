import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { FileText } from "lucide-react";
import { easeInOut, prog, rise, useLayout } from "../anim";
import { Bar, Eyebrow, Footnote, Paper, StatusDot } from "../components/ui";
import { C, F } from "../theme";

const CLAUSES = [
  {
    n: 4,
    title: "Rent advance",
    status: "Needs attention",
    color: C.attention,
    note: "Asks for 24 months upfront, beyond the six-month limit.",
    cite: "Rent Act, 1963 (Act 220) · s.25",
  },
  {
    n: 7,
    title: "Security deposit",
    status: "Worth checking",
    color: C.worth,
    note: "Refund terms are unclear. Suggested wording provided.",
    cite: "Negotiation point",
  },
  {
    n: 9,
    title: "Governing law",
    status: "Looks fine",
    color: C.fine,
    note: "Consistent with the published law for Ghana.",
    cite: "Laws of the Republic of Ghana",
  },
  {
    n: 12,
    title: "Dispute resolution",
    status: "Couldn't confirm",
    color: C.unknown,
    note: "Not covered by the published library, so marked rather than guessed.",
    cite: "Flagged for your judgement",
  },
];

const SCAN_START = 92;
const SCAN_END = 236;

export const DocReview: React.FC = () => {
  const frame = useCurrentFrame();
  const { vertical } = useLayout();

  const upload = prog(frame, 30, 40, easeInOut);
  const chipIn = prog(frame, 22, 22);
  const docIn = prog(frame, 70, 28);
  const scan = interpolate(frame, [SCAN_START, SCAN_END], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const scanning = frame >= SCAN_START && frame <= SCAN_END + 6;
  // Clause i is reached by the scan line at this fraction of its travel.
  const reachAt = (i: number) => SCAN_START + ((i + 0.55) / CLAUSES.length) * (SCAN_END - SCAN_START);

  return (
    <Paper tone="light">
      <AbsoluteFill style={{ padding: vertical ? "120px 70px" : "80px 130px", justifyContent: vertical ? "center" : undefined }}>
        <div style={rise(frame, 0)}>
          <Eyebrow rule>03 · Review</Eyebrow>
        </div>
        <div
          style={{
            ...rise(frame, 6),
            marginTop: 22,
            fontFamily: F.serif,
            fontSize: vertical ? 92 : 84,
            lineHeight: 1,
            letterSpacing: "-0.03em",
            maxWidth: vertical ? 940 : 1500,
          }}
        >
          Check a document against the law before you rely on it.
        </div>

        <div
          style={{
            marginTop: vertical ? 56 : 50,
            display: "flex",
            flexDirection: vertical ? "column" : "row",
            gap: vertical ? 34 : 50,
            alignItems: "stretch",
          }}
        >
          {/* Document */}
          <div style={{ width: vertical ? "100%" : 720, position: "relative" }}>
            {/* Upload chip */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 18,
                padding: "16px 22px",
                background: C.white,
                border: `1.5px solid ${C.line}`,
                borderRadius: 14,
                opacity: chipIn,
                transform: `translateY(${(1 - chipIn) * -40}px)`,
              }}
            >
              <div style={{ width: 48, height: 48, borderRadius: 10, background: C.paper, display: "grid", placeItems: "center", color: C.attention }}>
                <FileText size={26} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 24, fontWeight: 700 }}>Tenancy-Agreement.pdf</div>
                <div style={{ marginTop: 8, height: 6, borderRadius: 3, background: C.paperDeep, overflow: "hidden" }}>
                  <div style={{ width: `${upload * 100}%`, height: "100%", background: upload >= 1 ? C.fine : C.copper }} />
                </div>
              </div>
              <div style={{ fontSize: 20, color: C.inkSoft, width: 150, textAlign: "right" }}>
                {upload >= 1 ? "12 pages · ready" : `${Math.round(upload * 100)}%`}
              </div>
            </div>

            <div
              style={{
                position: "relative",
                marginTop: 18,
                background: C.white,
                border: `1.5px solid ${C.line}`,
                borderRadius: 14,
                padding: "26px 30px",
                overflow: "hidden",
                opacity: docIn,
                transform: `translateY(${(1 - docIn) * 30}px)`,
              }}
            >
              <Eyebrow color={C.ink} style={{ fontSize: 18 }}>
                Your document
              </Eyebrow>
              {CLAUSES.map((c, i) => {
                const hit = prog(frame, reachAt(i), 12);
                return (
                  <div
                    key={c.n}
                    style={{
                      marginTop: 22,
                      paddingLeft: 18,
                      borderLeft: `4px solid ${hit > 0 ? c.color : C.paperDeep}`,
                      background: `color-mix(in oklch, ${c.color} ${hit * 7}%, transparent)`,
                      paddingTop: 6,
                      paddingBottom: 8,
                    }}
                  >
                    <div style={{ fontSize: 24 }}>
                      <b>Clause {c.n}</b> <span style={{ color: C.inkSoft }}>{c.title}</span>
                    </div>
                    <Bar w="94%" h={9} style={{ marginTop: 12 }} />
                    <Bar w="62%" h={9} style={{ marginTop: 10 }} />
                  </div>
                );
              })}
              {/* Scan line */}
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: `${8 + scan * 90}%`,
                  height: 90,
                  marginTop: -90,
                  background: "linear-gradient(180deg, transparent, rgb(239 154 92 / 0.24))",
                  borderBottom: `3px solid ${C.copper}`,
                  opacity: scanning ? 1 : 0,
                }}
              />
            </div>
          </div>

          {/* Findings */}
          <div
            style={{
              flex: 1,
              background: C.paper,
              border: `1.5px solid ${C.line}`,
              borderRadius: 14,
              padding: "26px 32px",
              opacity: docIn,
            }}
          >
            <Eyebrow color={C.ink} style={{ fontSize: 18 }}>
              Findings
            </Eyebrow>
            {CLAUSES.map((c, i) => {
              const p = prog(frame, reachAt(i) + 4, 22);
              return (
                <div
                  key={c.n}
                  style={{
                    marginTop: 18,
                    paddingBottom: 16,
                    borderBottom: i < CLAUSES.length - 1 ? `1px solid ${C.line}` : "none",
                    opacity: p,
                    transform: `translateX(${(1 - p) * 40}px)`,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 18, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: c.color }}>
                    <StatusDot color={c.color} /> {c.status}
                  </div>
                  <div style={{ marginTop: 6, fontSize: 25, fontWeight: 700 }}>
                    Clause {c.n} · {c.title}
                  </div>
                  <div style={{ marginTop: 4, fontSize: 22, color: C.inkSoft }}>{c.note}</div>
                  <div style={{ marginTop: 6, fontSize: 17, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: C.copper }}>
                    {c.cite}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </AbsoluteFill>
      <Footnote start={250}>Illustrative example. General legal information, not legal advice.</Footnote>
    </Paper>
  );
};
