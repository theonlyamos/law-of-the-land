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
  const chatId = params.chatId as string;
  const searchParams = useSearchParams();
  const q = searchParams.get("q");
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const sessionData = useQuery(
    api.chats.getByExternalId,
    isAuthenticated ? { externalId: chatId } : "skip"
  );
  const [access, setAccess] = useState<AccessState>("pending");

  // Re-validate when switching chats via the sidebar.
  useEffect(() => {
    setAccess("pending");
  }, [chatId]);

  useEffect(() => {
    // Decide once per chat on entry. The workspace strips ?q= and creates the
    // session asynchronously, so re-evaluating here would reject the chat
    // mid-creation.
    if (access !== "pending") return;

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

    if (!sessionData && !q?.trim()) {
      setAccess("bad");
      return;
    }

    setAccess("ok");
  }, [access, authLoading, chatId, isAuthenticated, q, sessionData]);

  if (!isValidChatId(chatId) || access === "bad") {
    notFound();
  }

  if (authLoading) {
    return <PageLoader label="Loading chat…" />;
  }

  // While the chat's content loads, the workspace stays mounted and shows the
  // loading state in the chat panel only.
  return <ChatWorkspace chatId={chatId} initialQuery={q} />;
}

export default function ChatPage() {
  return (
    <div className="flex h-dvh flex-col">
      <Suspense fallback={<PageLoader label="Loading chat…" />}>
        <ChatPageInner />
      </Suspense>
    </div>
  );
}
