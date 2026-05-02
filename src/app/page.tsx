"use client";

import { LandingPage } from "@/components/landing-page";
import { loadChatSessions, type ChatSession } from "@/lib/chat-sessions";
import { useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";

function LandingShell() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [savedChats, setSavedChats] = useState<ChatSession[]>([]);

  useEffect(() => {
    const refresh = () => setSavedChats(loadChatSessions());
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  const resumeChat = useCallback(
    (chatId: string) => {
      if (!chatId) return;
      router.push(`/${chatId}`);
    },
    [router]
  );

  const goToChat = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const id = crypto.randomUUID();
      router.push(`/${id}?q=${encodeURIComponent(trimmed)}`);
    },
    [router]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        goToChat(query);
      }
    },
    [query, goToChat]
  );

  return (
    <div className="container relative mx-auto flex min-h-0 flex-1 flex-col overflow-hidden">
      <LandingPage
        query={query}
        onQueryChange={setQuery}
        onSearch={() => goToChat(query)}
        onPickSuggested={goToChat}
        onKeyDown={handleKeyDown}
        isLoading={false}
        savedChats={savedChats}
        onResumeChat={resumeChat}
      />
    </div>
  );
}

export default function Home() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Suspense
        fallback={
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center bg-background">
            <div className="flex flex-col items-center">
              <p className="mt-4 text-lg font-semibold">Starting Law of the Land…</p>
              <div className="mt-2 h-16 w-16 animate-spin rounded-full border-4 border-dashed border-primary" />
            </div>
          </div>
        }
      >
        <LandingShell />
      </Suspense>
    </div>
  );
}
