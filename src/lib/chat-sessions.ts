export interface Message {
  id?: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ChatSession {
  id: string;
  title: string;
  lastMessage: string;
  timestamp: Date;
  messageCount: number;
  messages: Message[];
}

interface StoredMessage extends Omit<Message, "createdAt" | "updatedAt"> {
  createdAt?: string;
  updatedAt?: string;
}

interface StoredChatSession extends Omit<ChatSession, "timestamp" | "messages"> {
  timestamp: string;
  messages: StoredMessage[];
}

const STORAGE_KEY = "chatSessions";

/** UUID v4 from crypto.randomUUID() — avoids matching arbitrary one-segment paths. */
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidChatId(id: string): boolean {
  return UUID_V4_RE.test(id);
}

export function loadChatSessions(): ChatSession[] {
  if (typeof window === "undefined") return [];
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (!saved) return [];
  try {
    return (JSON.parse(saved) as StoredChatSession[]).map((session) => ({
      ...session,
      timestamp: new Date(session.timestamp),
      messages: session.messages.map((msg) => ({
        ...msg,
        createdAt: msg.createdAt ? new Date(msg.createdAt) : undefined,
        updatedAt: msg.updatedAt ? new Date(msg.updatedAt) : undefined,
      })),
    }));
  } catch {
    return [];
  }
}

export function saveChatSessions(sessions: ChatSession[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
}
