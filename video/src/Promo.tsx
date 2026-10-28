import React, { useEffect, useState } from "react";
import { AbsoluteFill, Audio, continueRender, delayRender, staticFile } from "remotion";
import { TransitionSeries, linearTiming, type TransitionPresentation } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import { wipe } from "@remotion/transitions/wipe";
import { fontsReady } from "./fonts";
import timeline from "./timeline.json";
import { Intro } from "./scenes/Intro";
import { Problem } from "./scenes/Problem";
import { Hero } from "./scenes/Hero";
import { Ask } from "./scenes/Ask";
import { Answer } from "./scenes/Answer";
import { DocReview } from "./scenes/DocReview";
import { Audiences } from "./scenes/Audiences";
import { Organisations } from "./scenes/Organisations";
import { Features } from "./scenes/Features";
import { Outro } from "./scenes/Outro";

const COMPONENTS: Record<string, React.FC> = {
  Intro,
  Problem,
  Hero,
  Ask,
  Answer,
  DocReview,
  Audiences,
  Organisations,
  Features,
  Outro,
};

// Scene lengths live in timeline.json so the soundtrack script uses the same timing.
export const SCENES = timeline.scenes.map((s) => ({ C: COMPONENTS[s.id], d: s.duration }));

export const TRANSITION = timeline.transition;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const transitions: TransitionPresentation<any>[] = [
  fade(),
  wipe({ direction: "from-left" }),
  slide({ direction: "from-right" }),
  fade(),
  slide({ direction: "from-bottom" }),
  wipe({ direction: "from-right" }),
  slide({ direction: "from-right" }),
  fade(),
  wipe({ direction: "from-bottom" }),
];

export const PROMO_DURATION =
  SCENES.reduce((s, x) => s + x.d, 0) - TRANSITION * (SCENES.length - 1);

export const Promo: React.FC<{ withAudio?: boolean }> = ({ withAudio = true }) => {
  const [handle] = useState(() => delayRender("fonts"));
  useEffect(() => {
    fontsReady.then(() => continueRender(handle));
  }, [handle]);

  return (
    <AbsoluteFill style={{ background: "#f5ecdc" }}>
      <TransitionSeries>
        {SCENES.flatMap((s, i) => {
          const items = [
            <TransitionSeries.Sequence key={`s${i}`} durationInFrames={s.d}>
              <s.C />
            </TransitionSeries.Sequence>,
          ];
          if (i < SCENES.length - 1) {
            items.push(
              <TransitionSeries.Transition
                key={`t${i}`}
                presentation={transitions[i]}
                timing={linearTiming({ durationInFrames: TRANSITION })}
              />,
            );
          }
          return items;
        })}
      </TransitionSeries>
      {withAudio ? <Audio src={staticFile("soundtrack.mp3")} /> : null}
    </AbsoluteFill>
  );
};
