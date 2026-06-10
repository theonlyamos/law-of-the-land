import { loadChatSessions } from "@/lib/chat-sessions";

type MigrateArgs = {
  sessions: Array<{
    externalId: string;
    title: string;
    lastMessage: string;
    messageCount: number;
    updatedAt: number;
    messages: Array<{
      role: "user" | "assistant";
      content: string;
      clientId?: string;
      createdAt?: number;
    }>;
  }>;
};

export async function migrateLocalSessionsToConvex(
  migrateFromLocal: (args: MigrateArgs) => Promise<{ migratedCount: number }>
) {
  const localSessions = loadChatSessions();
  if (localSessions.length === 0) return { migratedCount: 0 };

  const payload = localSessions.map((session) => ({
    externalId: session.id,
    title: session.title,
    lastMessage: session.lastMessage,
    messageCount: session.messageCount,
    updatedAt: session.timestamp.getTime(),
    messages: session.messages.map((message) => ({
      role: message.role,
      content: message.content,
      clientId: message.id,
      createdAt: message.createdAt?.getTime(),
    })),
  }));

  const result = await migrateFromLocal({ sessions: payload });

  if (result.migratedCount > 0 && typeof window !== "undefined") {
    window.localStorage.removeItem("chatSessions");
  }

  return result;
}

export type { MigrateArgs };
