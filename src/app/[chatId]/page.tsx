"use client";

import { ChatWorkspace } from "@/components/chat/chat-workspace";
import { isValidChatId, loadChatSessions } from "@/lib/chat-sessions";
import { notFound, useParams, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

type AccessState = "pending" | "ok" | "bad";

function ChatPageInner() {
  const params = useParams();
  const chatId = params.chatId as string;
  const searchParams = useSearchParams();
  const q = searchParams.get("q");
  const [access, setAccess] = useState<AccessState>("pending");

  useEffect(() => {
    if (!isValidChatId(chatId)) {
      setAccess("bad");
      return;
    }
    const sessions = loadChatSessions();
    if (!sessions.some((s) => s.id === chatId) && !q?.trim()) {
      setAccess("bad");
      return;
    }
    setAccess("ok");
  }, [chatId, q]);

  if (access === "pending") {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center bg-background">
        <div className="h-16 w-16 animate-spin rounded-full border-4 border-dashed border-primary" />
        <p className="mt-4 text-lg font-semibold">Loading chat…</p>
      </div>
    );
  }

  if (access === "bad") {
    notFound();
  }

  return <ChatWorkspace chatId={chatId} initialQuery={q} />;
}

export default function ChatPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Suspense
        fallback={
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center bg-background">
            <div className="h-16 w-16 animate-spin rounded-full border-4 border-dashed border-primary" />
            <p className="mt-4 text-lg font-semibold">Loading chat…</p>
          </div>
        }
      >
        <ChatPageInner />
      </Suspense>
    </div>
  );
}
