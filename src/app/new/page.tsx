"use client";

import { ChatWorkspace } from "@/components/chat/chat-workspace";

export default function NewChatPage() {
  return (
    <div className="flex h-dvh flex-col">
      <ChatWorkspace chatId={null} initialQuery={null} />
    </div>
  );
}
