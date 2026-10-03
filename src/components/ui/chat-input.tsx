"use client";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ArrowUp, Send } from "lucide-react";
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
}: ChatInputProps) {
  const editorial = variant === "editorial";
  const SendIcon = editorial ? ArrowUp : Send;
  const sendButton = (
    <Button
      type="button"
      onClick={onSearch}
      disabled={disabled || isLoading || submitDisabled || !query.trim()}
      size="icon"
      className={`h-11 w-11 shrink-0 disabled:opacity-50 disabled:cursor-not-allowed ${editorial ? "rounded-lg shadow-none" : "absolute right-2 top-1/2 -translate-y-1/2"}`}
    >
      <SendIcon className={`h-5 w-5 ${isLoading ? "animate-pulse" : ""}`} aria-hidden="true" />
      <span className="sr-only">Send question</span>
    </Button>
  );

  return (
    <div className={`relative ${editorial ? "rounded-xl border border-input bg-card p-2 shadow-sm focus-within:ring-1 focus-within:ring-ring" : "flex items-center"} ${className || ""}`}>
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
          <div className="min-w-0 flex-1">{footer}</div>
          {sendButton}
        </div>
      ) : sendButton}
    </div>
  );
}
