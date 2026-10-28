# Law of the Land promo video

A ~72 second narrated motion graphics promo, built in code with [Remotion](https://remotion.dev).
It uses the app's own palette (from `src/components/landing/landing-page.module.css`) with the
Equal Nib copper accent, the app's fonts (Instrument Serif, DM Sans, Geist Mono), and an animated
copy of the Equal Nib mark (`src/components/LogoMark.tsx`, same geometry as
`src/components/brand/logo-mark.tsx` in the app).

Two compositions share the same scenes:

| Composition            | Size      | Use                          |
| ---------------------- | --------- | ---------------------------- |
| `LawOfTheLand`         | 1920×1080 | Website, YouTube, LinkedIn   |
| `LawOfTheLandVertical` | 1080×1920 | Reels, TikTok, Shorts, Status |

## Scenes

1. **Intro** – logo and wordmark reveal
2. **Problem** – scrolling statute pages: "Thousands of pages… one question that matters to you."
3. **Hero** – "Understand the law where you are."
4. **Ask** – choose Ghana, dictate a question by voice, send
5. **Understand** – answer streams in with citation chips and the cited source (Rent Act, 1963 (Act 220), s.25)
6. **Review** – a tenancy agreement is scanned clause by clause and labelled
7. **Audiences** – individuals, legal professionals, organisations
8. **Organisations** – review and publish a library, then embed the chat widget
9. **Features** – cited answers, voice, document review, saved research, workspaces, secure accounts
10. **Call to action** – "Begin with the jurisdiction whose law applies."

Scene lengths live in `src/timeline.json`; the narration script lives in `scripts/narration.json`.

## Commands

```bash
cd video
npm install
npm run studio             # live preview and scrubbing in the browser
npm run render             # out/law-of-the-land-promo.mp4
npm run render:vertical    # out/law-of-the-land-promo-vertical.mp4
```

In a sandbox without internet access to Remotion's Chrome download, point it at a local
headless Chrome: `REMOTION_CHROME=/path/to/chrome-headless-shell npm run render`.

## Audio

The soundtrack (`public/soundtrack.mp3`) is generated, not sampled:

1. `scripts/make-narration.py` voices `scripts/narration.json` with
   [Kokoro](https://github.com/thewh1teagle/kokoro-onnx) (open-weight TTS, Apache 2.0, voice `af_heart`)
   and writes `public/narration/*.wav` plus `src/narration.json` with clip lengths.
2. `scripts/make-soundtrack.py` synthesises a calm music bed (pads, bass, soft arpeggio, transition
   whooshes), places each narration clip at its scene, ducks the music under the voice and writes
   `public/soundtrack.wav` and `public/soundtrack.mp3`.

```bash
pip install kokoro-onnx soundfile numpy
# download kokoro-v1.0.onnx and voices-v1.0.bin from the kokoro-onnx "model-files-v1.0" release
python3 scripts/make-narration.py /path/to/model-folder af_heart
python3 scripts/make-soundtrack.py
```

To change the wording, edit `scripts/narration.json`, rerun both scripts, and lengthen a scene in
`src/timeline.json` if its line no longer fits. To use a professional voice-over instead, replace
the files in `public/narration/` with your recordings (same names) and rerun `make-soundtrack.py`.

## Licensing note

Remotion is free for individuals and companies with up to three employees; larger companies need
a [company licence](https://remotion.dev/license).
