"use client";

import { LandingPage } from "@/components/landing-page";
import type { ChatSession } from "@/lib/chat-sessions";
import type { ResearchJurisdiction } from "@/lib/countries";
import { api } from "@/convex/_generated/api";
import { useConvexAuth, usePaginatedQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

export function LandingShell({ guestResearchEnabled }: { guestResearchEnabled: boolean }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [researchJurisdiction, setResearchJurisdiction] =
    useState<ResearchJurisdiction | null>(null);
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const { results: sessionsData } = usePaginatedQuery(
    api.chats.list,
    isAuthenticated ? {} : "skip",
    { initialNumItems: 30 }
  );

  const researchUnavailable = authLoading || !researchJurisdiction?.id;

  const savedChats = useMemo<ChatSession[]>(() => {
    return sessionsData.map((session) => ({
      id: session.id,
      title: session.title,
      lastMessage: session.lastMessage,
      timestamp: new Date(session.timestamp),
      messageCount: session.messageCount,
      messages: [],
    }));
  }, [sessionsData]);

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
      if (!trimmed || researchUnavailable) return;

      const selection = `&jurisdiction=${encodeURIComponent(researchJurisdiction!.id)}`;
      const destination = isAuthenticated || !guestResearchEnabled ? `/${crypto.randomUUID()}` : "/research";
      const chatUrl = `${destination}?q=${encodeURIComponent(trimmed)}${selection}`;
      router.push(isAuthenticated || guestResearchEnabled ? chatUrl : `/signin?mode=signup&redirect=${encodeURIComponent(chatUrl)}`);
    },
    [guestResearchEnabled, isAuthenticated, researchJurisdiction, researchUnavailable, router]
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
    <LandingPage
      query={query}
      onQueryChange={setQuery}
      onSearch={() => goToChat(query)}
      onPickSuggested={goToChat}
      onKeyDown={handleKeyDown}
      isLoading={researchUnavailable}
      savedChats={savedChats}
      onResumeChat={resumeChat}
      isAuthenticated={isAuthenticated}
      guestResearchEnabled={guestResearchEnabled}
      researchJurisdiction={researchJurisdiction}
      onResearchJurisdictionChange={setResearchJurisdiction}
    />
  );
}
