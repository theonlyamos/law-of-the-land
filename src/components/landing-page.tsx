"use client";

import { Button } from "@/components/ui/button";
import { ChatInput } from "@/components/ui/chat-input";
import type { ChatSession } from "@/lib/chat-sessions";
import { Check } from "lucide-react";
import Image from 'next/image';
import { useState } from "react";
import logo from '@/app/logo-transparent.png';

const SUGGESTED_QUESTIONS = [
  "What are my rights as a tenant?",
  "Can I get a refund for a defective product?",
  "What should I do if I get a speeding ticket?",
  "What are the rules for returning items to stores?",
  "What are my rights at work?"
];

interface LandingPageProps {
  query: string;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  onPickSuggested: (question: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  isLoading: boolean;
  savedChats: ChatSession[];
  onResumeChat: (chatId: string) => void;
}

export function LandingPage({
  query,
  onQueryChange,
  onSearch,
  onPickSuggested,
  onKeyDown,
  isLoading,
  savedChats,
  onResumeChat,
}: LandingPageProps) {
  const [historySelect, setHistorySelect] = useState("");
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-4">
      {/* Logo */}
      <Image
        src={logo}
        alt="Law of the Land Logo"
        width={120}
        className="md:w-40 mb-8"
        priority
      />
      
      {/* Writings in the middle */}
      <div className="text-center max-w-2xl mb-8">
        <h1 className="text-3xl md:text-4xl font-bold mb-4">
          Clear answers from legal sources
        </h1>
        <p className="text-lg text-muted-foreground mb-6">
          Ask in plain language. Answers use the legal document library behind this tool and include citations when the
          source text supports them. This is not a substitute for a lawyer reviewing your specific situation.
        </p>
        
        {/* Feature bullets */}
        <div className="flex flex-wrap justify-center gap-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <Check className="h-4 w-4 text-primary" />
            <span>Grounded in published legal text</span>
          </div>
          <div className="flex items-center gap-2">
            <Check className="h-4 w-4 text-primary" />
            <span>Plain-language summaries</span>
          </div>
          <div className="flex items-center gap-2">
            <Check className="h-4 w-4 text-primary" />
            <span>Chat history saved on this device</span>
          </div>
        </div>
      </div>
      
      {/* Textarea in the middle */}
      <div className="w-full max-w-2xl">
        {savedChats.length > 0 && (
          <div className="mb-3 w-full">
            <label
              htmlFor="landing-saved-chats"
              className="mb-1.5 block text-center text-sm font-medium text-foreground"
            >
              Continue a saved chat
            </label>
            <select
              id="landing-saved-chats"
              className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              value={historySelect}
              onChange={(e) => {
                const id = e.target.value;
                if (!id) return;
                onResumeChat(id);
                setHistorySelect("");
              }}
            >
              <option value="">Choose a chat…</option>
              {savedChats.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.title}
                </option>
              ))}
            </select>
          </div>
        )}
        <ChatInput 
          query={query}
          onQueryChange={onQueryChange}
          onSearch={onSearch}
          onKeyDown={onKeyDown}
          isLoading={isLoading}
          rows={3}
          placeholder="e.g. What are my rights as a tenant?"
        />
      </div>
      
      {/* Suggested questions below */}
      <div className="w-full max-w-2xl mt-8">
        <p className="text-sm text-muted-foreground mb-3 text-center">Example questions:</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {SUGGESTED_QUESTIONS.map((question, index) => (
            <Button
              key={index}
              variant="outline"
              className="justify-start text-left h-auto py-2 px-4 text-sm md:text-base"
              onClick={() => onPickSuggested(question)}
            >
              {question}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
