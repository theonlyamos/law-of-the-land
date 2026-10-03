"use client";

import { ChatWorkspace } from "@/components/chat/chat-workspace";
import { PageLoader } from "@/components/ui/spinner";
import { isValidChatId } from "@/lib/chat-sessions";
import { api } from "@/convex/_generated/api";
import { useConvexAuth, useQuery } from "convex/react";
import { notFound, useParams, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

type AccessState = "pending" | "ok" | "bad";

function ChatPageInner() {
  const params = useParams();
  const chatId = (params.chatId as string | undefined) ?? null;
  const searchParams = useSearchParams();
  const q = chatId ? searchParams.get("q") : null;
  const jurisdiction = chatId ? searchParams.get("jurisdiction") : null;
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const sessionData = useQuery(
    api.chats.getByExternalId,
    isAuthenticated && chatId ? { externalId: chatId } : "skip"
  );
  const [access, setAccess] = useState<AccessState>("pending");

  // Re-validate when switching chats via the sidebar.
  useEffect(() => {
    setAccess("pending");
  }, [chatId]);

  useEffect(() => {
    // A jurisdiction identifies a chat being created by the workspace.
    // It may arrive before the session mutation completes.
    if (chatId === null || access !== "pending") return;

    if (!isValidChatId(chatId)) {
      setAccess("bad");
      return;
    }

    if (authLoading) return;

    if (!isAuthenticated) {
      setAccess("bad");
      return;
    }

    if (sessionData === undefined) return;

    if (!sessionData && !jurisdiction?.trim()) {
      setAccess("bad");
      return;
    }

    setAccess("ok");
  }, [access, authLoading, chatId, isAuthenticated, jurisdiction, q, sessionData]);

  if (chatId !== null && (!isValidChatId(chatId) || access === "bad")) {
    notFound();
  }

  // While the chat's content loads, the workspace stays mounted and shows the
  // loading state in the chat panel only.
  return <ChatWorkspace chatId={chatId} initialQuery={q} initialJurisdiction={jurisdiction} />;
}

export default function ChatRouteWorkspace() {
  return (
    <div className="flex h-dvh flex-col">
      <Suspense fallback={
        <div className="flex min-h-0 flex-1">
          <aside aria-hidden className="hidden w-60 shrink-0 border-r bg-[hsl(var(--chat-panel))] md:block" />
          <PageLoader label="Loading chat…" />
        </div>
      }>
        <ChatPageInner />
      </Suspense>
    </div>
  );
}
