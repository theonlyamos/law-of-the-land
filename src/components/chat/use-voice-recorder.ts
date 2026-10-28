"use client";

import React from "react";

import { cleanTranscript, MAX_RECORDING_SECONDS } from "@/lib/voice-transcription";

export type VoiceRecorderStatus = "idle" | "requesting" | "recording" | "transcribing";
export type Transcribe = (audio: Blob, signal: AbortSignal) => Promise<string>;

const PREFERRED_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
const MIN_RECORDING_MS = 400;

function recorderType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return undefined;
  return PREFERRED_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

function microphoneError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access is blocked. Allow it in your browser settings to dictate.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found. Connect one and try again.";
  if (name === "NotReadableError") return "Your microphone is in use by another app. Close it and try again.";
  return "The microphone couldn't start. Try again, or type your question.";
}

/** Sends a recording to the transcription endpoint and returns the text. */
export const transcribeRecording: Transcribe = async (audio, signal) => {
  const response = await fetch("/api/transcribe", {
    method: "POST",
    headers: { "content-type": audio.type || "audio/webm" },
    body: audio,
    signal,
  });
  const body = await response.json().catch(() => null) as { text?: unknown; error?: unknown } | null;
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "We couldn't transcribe that recording. Try again, or type your question.");
  return cleanTranscript(typeof body?.text === "string" ? body.text : "");
};

/**
 * Records from the microphone, exposes a live analyser for the waveform,
 * and hands the finished recording to `transcribe`.
 */
export function useVoiceRecorder({ transcribe, onTranscript }: { transcribe: Transcribe; onTranscript: (text: string) => void }) {
  const [status, setStatus] = React.useState<VoiceRecorderStatus>("idle");
  const [error, setError] = React.useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = React.useState(0);
  const [analyser, setAnalyser] = React.useState<AnalyserNode | null>(null);

  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const audioContextRef = React.useRef<AudioContext | null>(null);
  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = React.useRef(0);
  const discardRef = React.useRef(false);
  const abortRef = React.useRef<AbortController | null>(null);
  const mountedRef = React.useRef(true);
  const callbacks = React.useRef({ transcribe, onTranscript });
  callbacks.current = { transcribe, onTranscript };

  const release = React.useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    recorderRef.current = null;
    if (mountedRef.current) setAnalyser(null);
  }, []);

  const stop = React.useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }, []);

  const cancel = React.useCallback(() => {
    discardRef.current = true;
    abortRef.current?.abort();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    else release();
    setStatus("idle");
  }, [release]);

  const start = React.useCallback(async () => {
    if (recorderRef.current || status !== "idle") return;
    setError(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Voice input isn't supported in this browser.");
      return;
    }
    setStatus("requesting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (cause) {
      if (mountedRef.current) { setStatus("idle"); setError(microphoneError(cause)); }
      return;
    }
    if (!mountedRef.current) { stream.getTracks().forEach((track) => track.stop()); return; }
    streamRef.current = stream;

    try {
      const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioContextClass) {
        const context = new AudioContextClass();
        const node = context.createAnalyser();
        node.fftSize = 1024;
        node.smoothingTimeConstant = 0.6;
        context.createMediaStreamSource(stream).connect(node);
        audioContextRef.current = context;
        setAnalyser(node);
      }
    } catch {
      // The waveform is a nicety; recording still works without it.
    }

    const type = recorderType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32_000 } : undefined);
    } catch (cause) {
      release();
      setStatus("idle");
      setError(microphoneError(cause));
      return;
    }
    const chunks: Blob[] = [];
    discardRef.current = false;
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = async () => {
      const duration = Date.now() - startedAtRef.current;
      const blob = new Blob(chunks, { type: recorder.mimeType || type || "audio/webm" });
      release();
      if (!mountedRef.current || discardRef.current) return;
      if (duration < MIN_RECORDING_MS || blob.size === 0) {
        setStatus("idle");
        setError("That recording was too short. Click the microphone and speak your question.");
        return;
      }
      setStatus("transcribing");
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const text = await callbacks.current.transcribe(blob, controller.signal);
        if (!mountedRef.current || controller.signal.aborted) return;
        if (text) callbacks.current.onTranscript(text);
        else setError("We couldn't make out any speech. Try again a little closer to the microphone.");
      } catch (cause) {
        if (!mountedRef.current || controller.signal.aborted) return;
        setError(cause instanceof Error && cause.message ? cause.message : "We couldn't transcribe that recording. Try again, or type your question.");
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        if (mountedRef.current && !controller.signal.aborted) setStatus("idle");
      }
    };
    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    recorder.start(250);
    setStatus("recording");
    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current;
      setElapsedMs(elapsed);
      if (elapsed >= MAX_RECORDING_SECONDS * 1000) stop();
    }, 200);
  }, [release, status, stop]);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      discardRef.current = true;
      abortRef.current?.abort();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      release();
    };
  }, [release]);

  return { status, error, clearError: () => setError(null), elapsedMs, analyser, start, stop, cancel };
}
