"use client";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ArrowUp, Paperclip, Send } from "lucide-react";
import React from "react";

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
  attachments?: {
    accept: string;
    hasFiles: boolean;
    disabled?: boolean;
    tray: React.ReactNode;
    onFiles: (files: File[]) => void;
  };
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
  attachments,
}: ChatInputProps) {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);
  const attachmentDisabled = disabled || isLoading || attachments?.disabled;
  const editorial = variant === "editorial";
  const SendIcon = editorial ? ArrowUp : Send;
  const sendButton = (
    <Button
      type="button"
      onClick={onSearch}
      disabled={disabled || isLoading || submitDisabled || (!query.trim() && !hasFiles && !attachments?.hasFiles)}
      size="icon"
      className={`h-11 w-11 shrink-0 disabled:opacity-50 disabled:cursor-not-allowed ${editorial ? "rounded-lg shadow-none" : "absolute right-2 top-1/2 -translate-y-1/2"}`}
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
      <Textarea
        id={id} maxLength={maxLength} aria-describedby={describedBy}
        aria-label={ariaLabel ?? (editorial ? "Your legal question" : undefined)}
        placeholder={placeholder}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={onKeyDown}
        value={query}
        disabled={disabled || isLoading}
        className={`resize-none min-h-[56px] max-h-[200px] scrollbar-hide ${editorial ? "border-0 px-3 py-3 text-base leading-7 shadow-none focus-visible:ring-0" : "pr-14"}`}
        rows={rows}
        style={{
          scrollbarWidth: 'none'
        }}
      />
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
          {sendButton}
        </div>
      ) : sendButton}
    </div>
  );
}
