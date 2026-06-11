"use client";

import { ChatInput } from "@/components/ui/chat-input";
import type { ChatSession } from "@/lib/chat-sessions";
import { ArrowUpRight, Check, MessageSquare } from "lucide-react";
import Link from "next/link";

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
  const recentChats = savedChats.slice(0, 3);

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <div className="container relative mx-auto flex flex-1 items-center px-4 py-12 lg:py-16">
        {/* Anchored to the content container, not the viewport, so it stays
            aligned with the hero at any screen width. */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <span className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/3 select-none text-[26rem] font-semibold leading-none text-foreground/[0.03] max-lg:hidden">
            §
          </span>
        </div>
        <div className="grid w-full items-center gap-12 lg:grid-cols-[1.1fr_minmax(0,540px)] lg:gap-20">
          <div>
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-brand">
              <span aria-hidden className="text-base leading-none">§</span>
              Grounded legal answers
            </p>
            <h1 className="mt-4 text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
              Know what the law says — and where it says it.
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted-foreground">
              Ask about your rights in plain language. Answers are grounded in the legal document
              library and cite the exact sections, so you can check every claim yourself.
            </p>

            <ul className="mt-8 space-y-3 text-sm">
              <li className="flex items-start gap-3">
                <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                <span>Answers come from published legal text, not internet guesses</span>
              </li>
              <li className="flex items-start gap-3">
                <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                <span>Citations point to the sections and articles that apply</span>
              </li>
              <li className="flex items-start gap-3">
                <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                <span>
                  {isAuthenticated
                    ? "Your chat history syncs to your account"
                    : "Free to try — sign in to keep your chat history"}
                </span>
              </li>
            </ul>
          </div>

          <div className="rounded-xl border bg-card p-5 shadow-elegant-lg sm:p-6">
            <h2 className="text-sm font-medium">Ask a question</h2>
            <div className="mt-3">
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
            {!isAuthenticated && (
              <p className="mt-3 text-xs text-muted-foreground">
                <Link
                  href="/signin"
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                >
                  Sign in
                </Link>{" "}
                to save chats and pick them up on any device.
              </p>
            )}

            <div className="mt-6">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Or start from an example
              </p>
              <div className="-mx-2 mt-2">
                {SUGGESTED_QUESTIONS.map((question) => (
                  <button
                    key={question}
                    type="button"
                    onClick={() => onPickSuggested(question)}
                    className="group flex w-full items-center justify-between gap-3 rounded-md px-2 py-2.5 text-left text-sm transition hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <span>{question}</span>
                    <ArrowUpRight
                      aria-hidden
                      className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100"
                    />
                  </button>
                ))}
              </div>
            </div>

            {isAuthenticated && recentChats.length > 0 && (
              <div className="mt-6 border-t pt-4">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Pick up where you left off
                </p>
                <div className="-mx-2 mt-2">
                  {recentChats.map((session) => (
                    <button
                      key={session.id}
                      type="button"
                      onClick={() => onResumeChat(session.id)}
                      className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <MessageSquare
                        aria-hidden
                        className="h-4 w-4 shrink-0 text-muted-foreground"
                      />
                      <span className="truncate">{session.title}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
