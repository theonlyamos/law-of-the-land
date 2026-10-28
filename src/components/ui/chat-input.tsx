"use client";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ArrowUp, Loader2, Mic, Paperclip, Send, Square, X } from "lucide-react";
import React from "react";

import { useVoiceRecorder, type Transcribe } from "@/components/chat/use-voice-recorder";
import { VoiceWaveform } from "@/components/chat/voice-waveform";
import { appendTranscript } from "@/lib/voice-transcription";

export interface ChatInputProps {
  disabled?: boolean;
  id?: string;
  maxLength?: number;
  describedBy?: string;
  query: string;
  onQueryChange: (value: string) => void;
  onSearch: () => void; // Simplified: will call with internal query
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  isLoading: boolean;
  placeholder?: string;
  rows?: number;
  className?: string; // To allow parent to pass additional styling for the container
  variant?: "default" | "editorial";
  footer?: React.ReactNode;
  submitDisabled?: boolean;
  ariaLabel?: string;
  hasFiles?: boolean;
  /** When set, the submit button becomes a stop button that calls this. */
  onStop?: () => void;
  attachments?: {
    accept: string;
    hasFiles: boolean;
    disabled?: boolean;
    tray: React.ReactNode;
    onFiles: (files: File[]) => void;
  };
  /** Shows a microphone button (editorial variant) that dictates into the input. */
  transcribe?: Transcribe;
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function ChatInput({
  id, maxLength, describedBy, disabled = false,
  query,
  onQueryChange,
  onSearch,
  onKeyDown,
  isLoading,
  placeholder = "Ask a follow-up… Enter to send, Shift+Enter for a new line",
  rows = 1, // Default to 1, can be overridden
  className,
  variant = "default",
  footer,
  submitDisabled = false,
  ariaLabel,
  hasFiles = false,
  onStop,
  attachments,
  transcribe,
}: ChatInputProps) {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const [dragging, setDragging] = React.useState(false);
  const editorial = variant === "editorial";
  const latestQuery = React.useRef(query);
  latestQuery.current = query;
  const voice = useVoiceRecorder({
    transcribe: transcribe ?? (async () => ""),
    onTranscript: (text) => {
      const next = appendTranscript(latestQuery.current, text);
      onQueryChange(maxLength ? next.slice(0, maxLength) : next);
      requestAnimationFrame(() => {
        const field = textareaRef.current;
        if (!field) return;
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
      });
    },
  });
  const voiceEnabled = Boolean(transcribe) && editorial;
  const voiceActive = voiceEnabled && voice.status !== "idle";
  const attachmentDisabled = disabled || isLoading || attachments?.disabled || voiceActive;

  React.useEffect(() => {
    if (voice.status !== "recording") return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") voice.cancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [voice.status, voice.cancel]);
  const SendIcon = editorial ? ArrowUp : Send;
  const buttonClassName = `h-11 w-11 shrink-0 disabled:opacity-50 disabled:cursor-not-allowed ${editorial ? "rounded-lg shadow-none" : "absolute right-2 top-1/2 -translate-y-1/2"}`;
  const sendButton = onStop ? (
    <Button
      type="button"
      onClick={onStop}
      size="icon"
      aria-label="Stop answer"
      title="Stop answer"
      className={buttonClassName}
    >
      <Square className="h-4 w-4 fill-current" aria-hidden="true" />
    </Button>
  ) : (
    <Button
      type="button"
      onClick={onSearch}
      disabled={disabled || isLoading || submitDisabled || voiceActive || (!query.trim() && !hasFiles && !attachments?.hasFiles)}
      size="icon"
      className={buttonClassName}
    >
      <SendIcon className={`h-5 w-5 ${isLoading ? "animate-pulse" : ""}`} aria-hidden="true" />
      <span className="sr-only">Send question</span>
    </Button>
  );

  return (
    <div className={`relative ${editorial ? "rounded-xl border border-input bg-card p-2 shadow-sm focus-within:ring-1 focus-within:ring-ring" : "flex items-center"} ${dragging ? "ring-2 ring-primary" : ""} ${className || ""}`}
      onDragOver={attachments ? (event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        if (!attachmentDisabled) setDragging(true);
      } : undefined}
      onDragLeave={attachments ? (event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      } : undefined}
      onDrop={attachments ? (event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        setDragging(false);
        if (!attachmentDisabled) attachments.onFiles(Array.from(event.dataTransfer.files));
      } : undefined}
      onPaste={attachments ? (event) => {
        const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
        if (!images.length) return;
        event.preventDefault();
        if (!attachmentDisabled) attachments.onFiles(images);
      } : undefined}>
      {attachments?.tray}
      {dragging && <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-background/95 text-sm font-medium text-primary">Drop files to attach</div>}
      {voiceActive && voice.status !== "requesting" ? (
        <div className="flex min-h-[56px] items-center gap-3 px-3 py-3" role="status" aria-live="polite">
          {voice.status === "recording" ? <>
            <span className="relative flex size-2.5 shrink-0" aria-hidden="true">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-60 motion-reduce:animate-none" />
              <span className="relative inline-flex size-2.5 rounded-full bg-red-500" />
            </span>
            <span className="sr-only">Recording. Click stop when you're done, or press Escape to discard.</span>
            <VoiceWaveform analyser={voice.analyser} className="h-8 min-w-0 flex-1 text-primary" />
            <span className="shrink-0 font-mono text-sm tabular-nums text-muted-foreground">{formatElapsed(voice.elapsedMs)}</span>
          </> : <>
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
            <span className="text-sm text-muted-foreground">Transcribing…</span>
          </>}
        </div>
      ) : <Textarea
        ref={textareaRef}
        id={id} maxLength={maxLength} aria-describedby={describedBy}
        aria-label={ariaLabel ?? (editorial ? "Your legal question" : undefined)}
        placeholder={placeholder}
        onChange={(e) => { if (voice.error) voice.clearError(); onQueryChange(e.target.value); }}
        onKeyDown={onKeyDown}
        value={query}
        disabled={disabled || isLoading}
        className={`resize-none min-h-[56px] max-h-[200px] scrollbar-hide ${editorial ? "border-0 px-3 py-3 text-base leading-7 shadow-none focus-visible:ring-0" : "pr-14"}`}
        rows={rows}
        style={{
          scrollbarWidth: 'none'
        }}
      />}
      {voiceEnabled && voice.error && <p role="alert" className="px-3 pb-1 text-sm text-destructive">{voice.error}</p>}
      {editorial ? (
        <div className="mt-2 flex items-center justify-between gap-2 pl-1">
          {attachments && <>
            <input ref={fileInputRef} type="file" multiple accept={attachments.accept} className="hidden" aria-label="Choose files to attach" disabled={attachmentDisabled}
              onChange={(event) => {
                attachments.onFiles(Array.from(event.target.files ?? []));
                event.target.value = "";
              }} />
            <Button type="button" variant="ghost" size="icon" disabled={attachmentDisabled}
              onClick={() => fileInputRef.current?.click()} aria-label="Attach files" title="Attach documents, text files or images" className="h-11 w-11 shrink-0 rounded-lg text-muted-foreground">
              <Paperclip className="size-4" aria-hidden="true" />
            </Button>
          </>}
          <div className="min-w-0 flex-1">{footer}</div>
          {voiceEnabled && voice.status === "recording" && (
            <Button type="button" variant="ghost" size="icon" onClick={voice.cancel}
              aria-label="Discard recording" title="Discard recording (Esc)" className="h-11 w-11 shrink-0 rounded-lg text-muted-foreground">
              <X className="size-4" aria-hidden="true" />
            </Button>
          )}
          {voiceEnabled && (voice.status === "recording" ? (
            <Button type="button" variant="outline" size="icon" onClick={voice.stop}
              aria-label="Stop recording and transcribe" title="Stop recording and transcribe" className="h-11 w-11 shrink-0 rounded-lg border-red-500/40 text-red-600 hover:bg-red-500/10 hover:text-red-600 dark:text-red-400 dark:hover:text-red-400">
              <Square className="size-3.5 fill-current" aria-hidden="true" />
            </Button>
          ) : (
            <Button type="button" variant="ghost" size="icon"
              disabled={disabled || isLoading || voice.status !== "idle"}
              onClick={() => void voice.start()}
              aria-label={voice.status === "transcribing" ? "Transcribing recording" : "Dictate your question"}
              title="Dictate your question"
              className="h-11 w-11 shrink-0 rounded-lg text-muted-foreground">
              {voice.status === "idle" ? <Mic className="size-4" aria-hidden="true" /> : <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
            </Button>
          ))}
          {sendButton}
        </div>
      ) : sendButton}
    </div>
  );
}
