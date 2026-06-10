"use client";

import { Button } from "@/components/ui/button";
import { ChatInput } from "@/components/ui/chat-input";
import type { ChatSession } from "@/lib/chat-sessions";
import { Check } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import logo from "@/app/logo-transparent.png";

const SUGGESTED_QUESTIONS = [
  "What are my rights as a tenant?",
  "Can I get a refund for a defective product?",
  "What should I do if I get a speeding ticket?",
  "What are the rules for returning items to stores?",
  "What are my rights at work?",
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
  isAuthenticated: boolean;
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
  isAuthenticated,
}: LandingPageProps) {
  const [historySelect, setHistorySelect] = useState("");

  return (
    <div className="flex flex-1 flex-col items-center justify-center p-4">
      <Image
        src={logo}
        alt="Law of the Land Logo"
        width={120}
        className="mb-8 md:w-40"
        priority
      />

      <div className="mb-8 max-w-2xl text-center">
        <h1 className="mb-4 text-3xl font-bold md:text-4xl">Clear answers from legal sources</h1>
        <p className="mb-6 text-lg text-muted-foreground">
          Ask in plain language. Answers use the legal document library behind this tool and include
          citations when the source text supports them. This is not a substitute for a lawyer
          reviewing your specific situation.
        </p>

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
            <span>
              {isAuthenticated ? "Chat history saved to your account" : "Sign in to save chat history"}
            </span>
          </div>
        </div>
      </div>

      <div className="w-full max-w-2xl">
        {!isAuthenticated && (
          <p className="mb-4 text-center text-sm text-muted-foreground">
            <Link href="/signin" className="font-medium text-foreground underline-offset-4 hover:underline">
              Sign in
            </Link>{" "}
            to save chats and manage sessions across devices.
          </p>
        )}
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

      <div className="mt-8 w-full max-w-2xl">
        <p className="mb-3 text-center text-sm text-muted-foreground">Example questions:</p>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {SUGGESTED_QUESTIONS.map((question, index) => (
            <Button
              key={index}
              variant="outline"
              className="h-auto justify-start px-4 py-2 text-left text-sm md:text-base"
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
