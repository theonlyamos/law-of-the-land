export const DEFAULT_TRANSCRIBE_MODEL = "gemini-3.5-transcribe";
/** Recordings stop on their own at this length, so a forgotten mic can't run up a bill. */
export const MAX_RECORDING_SECONDS = 120;
/** Stays under the hosting platform's 4.5 MB request body limit. */
export const MAX_RECORDING_BYTES = 4 * 1024 * 1024;

// Browsers report container types (Chrome/Firefox: webm or ogg, Safari: mp4).
// Gemini names some of these differently.
const AUDIO_TYPES: Record<string, string> = {
  "audio/webm": "audio/webm",
  "audio/ogg": "audio/ogg",
  "audio/mp4": "audio/m4a",
  "audio/x-m4a": "audio/m4a",
  "audio/m4a": "audio/m4a",
  "audio/aac": "audio/aac",
  "audio/mpeg": "audio/mpeg",
  "audio/mp3": "audio/mp3",
  "audio/wav": "audio/wav",
  "audio/x-wav": "audio/wav",
};

/** Maps a recorder content type such as `audio/webm;codecs=opus` to the type Gemini expects, or null. */
export function geminiAudioType(contentType: string | null | undefined): string | null {
  const base = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  return AUDIO_TYPES[base] ?? null;
}

/** Collapses whitespace so the transcript drops cleanly into the composer. */
export function cleanTranscript(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/gu, " ").trim();
}

/** Adds dictated text after whatever the person already typed. */
export function appendTranscript(current: string, transcript: string): string {
  if (!transcript) return current;
  if (!current.trim()) return transcript;
  return /\s$/u.test(current) ? `${current}${transcript}` : `${current} ${transcript}`;
}
