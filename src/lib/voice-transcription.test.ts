import { expect, it } from "vitest";
import { appendTranscript, cleanTranscript, geminiAudioType } from "./voice-transcription";

it("maps browser recorder types to Gemini audio types", () => {
  expect(geminiAudioType("audio/webm;codecs=opus")).toBe("audio/webm");
  expect(geminiAudioType("audio/mp4")).toBe("audio/m4a");
  expect(geminiAudioType("Audio/OGG; codecs=opus")).toBe("audio/ogg");
  expect(geminiAudioType("application/json")).toBeNull();
  expect(geminiAudioType(null)).toBeNull();
});

it("cleans and appends dictated text", () => {
  expect(cleanTranscript("  Can my employer\n fire me?  ")).toBe("Can my employer fire me?");
  expect(appendTranscript("", "Hello")).toBe("Hello");
  expect(appendTranscript("Under the Labour Act,", "can I be dismissed?")).toBe("Under the Labour Act, can I be dismissed?");
  expect(appendTranscript("Already spaced ", "text")).toBe("Already spaced text");
  expect(appendTranscript("Keep me", "")).toBe("Keep me");
});
