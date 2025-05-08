"use client";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send } from "lucide-react";
import React from "react";

interface ChatInputProps {
  query: string;
  onQueryChange: (value: string) => void;
  onSearch: () => void; // Simplified: will call with internal query
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  isLoading: boolean;
  placeholder?: string;
  rows?: number;
  className?: string; // To allow parent to pass additional styling for the container
}

export function ChatInput({
  query,
  onQueryChange,
  onSearch,
  onKeyDown,
  isLoading,
  placeholder = "Type your question here... (Press Enter to send)",
  rows = 1, // Default to 1, can be overridden
  className
}: ChatInputProps) {
  return (
    <div className={`relative flex items-center ${className || ''}`}>
      <Textarea
        placeholder={placeholder}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={onKeyDown}
        value={query}
        disabled={isLoading}
        className="resize-none pr-14 min-h-[56px] max-h-[200px] scrollbar-hide"
        rows={rows}
        style={{
          scrollbarWidth: 'none'
        }}
      />
      <Button
        onClick={onSearch}
        disabled={isLoading || !query.trim()}
        size="icon"
        className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Send className={`h-5 w-5 ${isLoading ? 'animate-pulse' : ''}`} />
        <span className="sr-only">Send message</span>
      </Button>
    </div>
  );
} 