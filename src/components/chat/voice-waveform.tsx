"use client";

import React from "react";

const BAR_WIDTH = 3;
const BAR_GAP = 2;
const SAMPLE_MS = 45;
const MIN_BAR = 2;

/** Turns raw RMS (usually 0–0.3 for speech) into a 0–1 height that reads well. */
function level(rms: number): number {
  return Math.min(1, Math.pow(Math.min(1, rms * 4), 0.7));
}

/**
 * Scrolling bar waveform of the live microphone level. Newest audio enters on
 * the right; quieter history fades toward the left edge.
 */
export function VoiceWaveform({ analyser, className }: { analyser: AnalyserNode | null; className?: string }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    let width = 0;
    let height = 0;
    let history: number[] = [];
    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    resize();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(canvas);

    const samples = new Uint8Array(analyser?.fftSize ?? 0);
    let frame = 0;
    let lastSample = 0;
    let smoothed = 0;

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const capacity = Math.max(1, Math.floor((width + BAR_GAP) / (BAR_WIDTH + BAR_GAP)));
      if (analyser) {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) {
          const value = (sample - 128) / 128;
          sum += value * value;
        }
        const current = level(Math.sqrt(sum / (samples.length || 1)));
        // Rise fast, fall slower, so syllables read as distinct peaks.
        smoothed = current > smoothed ? current : smoothed * 0.8 + current * 0.2;
      }
      if (now - lastSample >= SAMPLE_MS) {
        lastSample = now;
        history.push(smoothed);
        // Keep a full row of bars so silence shows as a quiet baseline.
        if (history.length < capacity) history = [...new Array<number>(capacity - history.length).fill(0), ...history];
        if (history.length > capacity) history = history.slice(history.length - capacity);
      }

      context.clearRect(0, 0, width, height);
      const color = getComputedStyle(canvas).color;
      const mid = height / 2;
      const offset = width - history.length * (BAR_WIDTH + BAR_GAP) + BAR_GAP;
      history.forEach((value, index) => {
        const barHeight = Math.max(MIN_BAR, value * (height - 4));
        const x = offset + index * (BAR_WIDTH + BAR_GAP);
        const fade = Math.min(1, 0.25 + (index / Math.max(1, capacity)) * 1.5);
        context.globalAlpha = fade;
        context.fillStyle = color;
        context.beginPath();
        if (typeof context.roundRect === "function") context.roundRect(x, mid - barHeight / 2, BAR_WIDTH, barHeight, BAR_WIDTH / 2);
        else context.rect(x, mid - barHeight / 2, BAR_WIDTH, barHeight);
        context.fill();
      });
      context.globalAlpha = 1;
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [analyser]);

  return <canvas ref={canvasRef} aria-hidden="true" className={className} data-testid="voice-waveform" />;
}
