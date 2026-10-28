import React from "react";
import { Composition } from "remotion";
import { PROMO_DURATION, Promo } from "./Promo";

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="LawOfTheLand"
      component={Promo}
      durationInFrames={PROMO_DURATION}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={{ withAudio: true }}
    />
    <Composition
      id="LawOfTheLandVertical"
      component={Promo}
      durationInFrames={PROMO_DURATION}
      fps={30}
      width={1080}
      height={1920}
      defaultProps={{ withAudio: true }}
    />
  </>
);
