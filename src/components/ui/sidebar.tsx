import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ChatSession } from "@/lib/chat-sessions";
import { Clock, MessageSquare, MessageSquarePlus, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

interface SidebarProps {
  sessions: ChatSession[];
  activeSession?: string;
  isOpen: boolean;
  onAfterSessionNavigate?: () => void;
  onNewSession: () => void;
  onDeleteSession: (sessionId: string) => void;
  onClose: () => void;
}

export function Sidebar({
  sessions,
  activeSession,
  isOpen,
  onAfterSessionNavigate,
  onNewSession,
  onDeleteSession,
  onClose,
}: SidebarProps) {
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const formatTimestamp = (date: Date) => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) {
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    if (days === 1) {
      return "Yesterday";
    }
    if (days < 7) {
      return date.toLocaleDateString([], { weekday: "long" });
    }
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  };

  return (
    <div
      className={`
        flex h-full min-h-0 w-64 min-w-64 flex-col border-r bg-background
        fixed z-50 transform transition-transform duration-300 ease-in-out
        md:static md:z-auto
        ${isOpen ? "translate-x-0" : "-translate-x-full"}
        md:translate-x-0
      `}
    >
      <div className="border-b p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Chats</h2>
          <div className="flex items-center">
            <Button
              variant="ghost"
              size="icon"
              onClick={onNewSession}
              className="h-11 w-11"
              aria-label="Start a new chat"
            >
              <MessageSquarePlus className="h-5 w-5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="ml-2 h-11 w-11 md:hidden"
              aria-label="Close chat list"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 p-3">
          {sessions.length === 0 ? (
            <div className="py-4 text-center text-muted-foreground">
              No saved chats yet. Use the + button to start one.
            </div>
          ) : (
            sessions.map((session, index) => (
              <div
                key={session.id}
                className={`group relative border-b border-border/50 pb-1 last:border-b-0 ${index > 0 ? "pt-1" : ""}`}
              >
                <Button
                  asChild
                  variant={activeSession === session.id ? "secondary" : "ghost"}
                  className="h-auto w-full min-w-0 justify-start gap-2 px-4 py-3"
                >
                  <Link
                    href={`/${session.id}`}
                    onClick={() => onAfterSessionNavigate?.()}
                  >
                    <MessageSquare className="mt-0.5 h-4 w-4 shrink-0" />
                    <div className="min-w-0 flex-1 pr-10 text-left">
                      <div className="truncate text-sm font-medium">{session.title}</div>
                      <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3 shrink-0" />
                        <span className="truncate">{formatTimestamp(session.timestamp)}</span>
                      </div>
                    </div>
                  </Link>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100"
                  aria-label={`Delete chat: ${session.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    setDeleteConfirm(session.id);
                  }}
                >
                  <Trash2 className="h-3 w-3 text-destructive" />
                </Button>

                {deleteConfirm === session.id && (
                  <div  className="absolute right-0 top-0 bottom-0 z-10 flex w-2/3 items-center justify-center gap-1 rounded-r-lg bg-background/95 pr-2 backdrop-blur-sm">
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteSession(session.id);
                        setDeleteConfirm(null);
                      }}
                    >
                      Delete chat
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteConfirm(null);
                      }}
                    >
                      Keep
                    </Button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
