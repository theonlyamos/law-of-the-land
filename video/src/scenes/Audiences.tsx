import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Briefcase, Building2, User } from "lucide-react";
import { prog, rise, useLayout } from "../anim";
import { Eyebrow, MaskLine, Paper } from "../components/ui";
import { C, F } from "../theme";

const AUDIENCES = [
  {
    register: "01 / Public",
    title: "Individuals",
    Icon: User,
    needs: ["Housing and tenancy", "Employment rights", "Consumer protection"],
  },
  {
    register: "02 / Practice",
    title: "Legal professionals",
    Icon: Briefcase,
    needs: ["Preliminary research", "Section discovery", "First-pass document review"],
  },
  {
    register: "03 / Operations",
    title: "Organisations",
    Icon: Building2,
    needs: ["Business obligations", "Regulatory requirements", "Policy and contract review"],
  },
];

export const Audiences: React.FC = () => {
  const frame = useCurrentFrame();
  const { vertical } = useLayout();

  return (
    <Paper>
      <AbsoluteFill style={{ padding: vertical ? "120px 80px" : "110px 130px", justifyContent: vertical ? "center" : undefined }}>
        <div style={rise(frame, 0)}>
          <Eyebrow rule>Who it's for</Eyebrow>
        </div>
        <div
          style={{
            marginTop: 24,
            fontFamily: F.serif,
            fontSize: vertical ? 104 : 100,
            lineHeight: 1,
            letterSpacing: "-0.03em",
          }}
        >
          <MaskLine start={4}>Clear answers for</MaskLine>
          <MaskLine start={12}>
            <span style={{ fontStyle: "italic", color: C.copper }}>everyone the law affects.</span>
          </MaskLine>
        </div>

        <div
          style={{
            marginTop: vertical ? 70 : 80,
            display: "flex",
            flexDirection: vertical ? "column" : "row",
            gap: vertical ? 30 : 40,
          }}
        >
          {AUDIENCES.map((a, i) => {
            const start = 30 + i * 14;
            const rule = prog(frame, start, 30);
            return (
              <div key={a.title} style={{ flex: 1, ...rise(frame, start, 36) }}>
                <div style={{ height: 2, background: C.ink, width: `${rule * 100}%` }} />
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 24 }}>
                  <span style={{ fontSize: 20, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", color: C.copper }}>
                    {a.register}
                  </span>
                  <a.Icon size={32} color={C.inkSoft} strokeWidth={1.6} />
                </div>
                <div style={{ marginTop: vertical ? 10 : 18, fontFamily: F.serif, fontSize: vertical ? 64 : 58, lineHeight: 1.05 }}>{a.title}</div>
                <div style={{ marginTop: vertical ? 12 : 22, display: vertical ? "flex" : "block", flexWrap: "wrap", gap: "6px 26px" }}>
                  {a.needs.map((n, j) => (
                    <div
                      key={n}
                      style={{
                        ...rise(frame, start + 20 + j * 6, 14),
                        fontSize: vertical ? 26 : 26,
                        color: C.inkSoft,
                        padding: vertical ? 0 : "10px 0",
                        borderBottom: vertical ? "none" : `1px solid ${C.line}`,
                      }}
                    >
                      — {n}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
    </Paper>
  );
};
