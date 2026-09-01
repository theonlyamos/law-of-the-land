"use client";

import { LandingPage } from "@/components/landing-page";
import { PageLoader } from "@/components/ui/spinner";
import type { ChatSession } from "@/lib/chat-sessions";
import {
  chooseJurisdictionCode,
  type ResearchJurisdiction,
} from "@/lib/countries";
import { api } from "@/convex/_generated/api";
import { useConvexAuth, usePaginatedQuery, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";

function LandingShell() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [country, setCountry] = useState("");
  const [researchJurisdiction, setResearchJurisdiction] =
    useState<ResearchJurisdiction | null>(null);
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const unifiedJurisdictionsEnabled = useQuery(
    api.jurisdictions.isUnifiedJurisdictionsEnabled,
  );
  const publicJurisdictions = useQuery(
    api.jurisdictions.listPublicEnabled,
    unifiedJurisdictionsEnabled === false ? {} : "skip",
  );
  const { results: sessionsData } = usePaginatedQuery(
    api.chats.list,
    isAuthenticated ? {} : "skip",
    { initialNumItems: 30 }
  );

  useEffect(() => {
    if (unifiedJurisdictionsEnabled !== false || publicJurisdictions === undefined) return;
    setCountry((current) => chooseJurisdictionCode(publicJurisdictions, current));
  }, [publicJurisdictions, unifiedJurisdictionsEnabled]);

  const compatibilityCode = unifiedJurisdictionsEnabled === true
    ? researchJurisdiction?.legacyCountryCode ?? null
    : country || null;

  const researchUnavailable =
    authLoading ||
    unifiedJurisdictionsEnabled === undefined ||
    (unifiedJurisdictionsEnabled === false &&
      (publicJurisdictions === undefined || publicJurisdictions.length === 0)) ||
    (unifiedJurisdictionsEnabled === true ? !researchJurisdiction?.id : !compatibilityCode);

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

      const normalizedCountry = compatibilityCode?.trim().toUpperCase() || null;
      const selection = unifiedJurisdictionsEnabled === true
        ? `&jurisdiction=${encodeURIComponent(researchJurisdiction!.id)}${normalizedCountry ? `&country=${encodeURIComponent(normalizedCountry)}` : ""}`
        : `&country=${encodeURIComponent(normalizedCountry!)}`;
      const chatUrl = `/${crypto.randomUUID()}?q=${encodeURIComponent(trimmed)}${selection}`;
      router.push(isAuthenticated ? chatUrl : `/signin?redirect=${encodeURIComponent(chatUrl)}`);
    },
    [compatibilityCode, isAuthenticated, researchJurisdiction, researchUnavailable, router, unifiedJurisdictionsEnabled]
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
      country={country}
      onCountryChange={setCountry}
      jurisdictions={publicJurisdictions}
      unifiedJurisdictionsEnabled={unifiedJurisdictionsEnabled}
      researchJurisdiction={researchJurisdiction}
      onResearchJurisdictionChange={setResearchJurisdiction}
    />
  );
}

export default function Home() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Suspense fallback={<PageLoader label="Starting Law of the Land…" />}>
        <LandingShell />
      </Suspense>
    </div>
  );
}
