import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

export const fontsReady = Promise.all([
  loadFont({ family: "Instrument Serif", url: staticFile("fonts/InstrumentSerif-Latin.woff2") }),
  loadFont({
    family: "Instrument Serif",
    url: staticFile("fonts/InstrumentSerif-Italic-Latin.woff2"),
    style: "italic",
  }),
  loadFont({ family: "DM Sans", url: staticFile("fonts/DMSans-Latin.woff2"), weight: "100 1000" }),
  loadFont({ family: "Geist Mono", url: staticFile("fonts/GeistMonoVF.woff"), weight: "100 900" }),
]);
