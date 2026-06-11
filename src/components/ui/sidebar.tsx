"use client";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ChatSession } from "@/lib/chat-sessions";
import { api } from "@/convex/_generated/api";
import { authClient } from "@/lib/auth-client";
import { useConvexAuth, useQuery } from "convex/react";
import {
  Clock,
  LogOut,
  MessageSquare,
  MessageSquarePlus,
  PanelLeft,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import logo from "@/app/logo-transparent.png";

interface SidebarProps {
  sessions: ChatSession[];
  activeSession?: string;
  /** Mobile drawer state (< md). */
  isOpen: boolean;
  /** Desktop icon-rail state (>= md). */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onAfterSessionNavigate?: () => void;
  onNewSession: () => void;
  onDeleteSession: (sessionId: string) => void;
  onClose: () => void;
}

export function Sidebar({
  sessions,
  activeSession,
  isOpen,
  collapsed = false,
  onToggleCollapse,
  onAfterSessionNavigate,
  onNewSession,
  onDeleteSession,
  onClose,
}: SidebarProps) {
  const router = useRouter();
  const { isAuthenticated } = useConvexAuth();
  const user = useQuery(api.users.current, isAuthenticated ? {} : "skip");
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const displayName = user?.name ?? user?.email ?? "Account";
  const initial = displayName.charAt(0).toUpperCase();

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

  const handleSignOut = async () => {
    try {
      await authClient.signOut();
      router.push("/");
    } catch (error) {
      console.error("Sign out failed:", error);
    }
  };

  const collapsibleLabel = collapsed ? "md:hidden" : "";
  const collapsibleRow = collapsed ? "md:h-11 md:w-11 md:justify-center md:px-0" : "";

  return (
    <div
      aria-label="Chat history"
      className={`
        flex h-full min-h-0 w-64 flex-col border-r bg-background
        fixed inset-y-0 left-0 z-50 transform
        transition-[transform,width,visibility] duration-300 ease-in-out
        md:static md:z-auto md:translate-x-0 md:visible
        ${isOpen ? "visible translate-x-0" : "invisible -translate-x-full"}
        ${collapsed ? "md:w-[4.25rem]" : "md:w-64"}
      `}
    >
      <div className={`flex items-center gap-1 p-3 ${collapsed ? "md:flex-col md:gap-2" : ""}`}>
        <Link
          href="/"
          aria-label="Law of the Land — home"
          className="flex h-11 w-11 shrink-0 items-center justify-center"
        >
          <Image src={logo} alt="" width={40} />
        </Link>
        <span
          className={`min-w-0 flex-1 truncate text-sm font-semibold ${collapsibleLabel}`}
        >
          Law of the Land
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleCollapse}
          className="hidden h-11 w-11 shrink-0 md:flex"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
        >
          <PanelLeft className="h-5 w-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="h-11 w-11 shrink-0 md:hidden"
          aria-label="Close chat list"
        >
          <X className="h-5 w-5" />
        </Button>
      </div>

      <div className="px-3 pb-2">
        <Button
          variant="outline"
          onClick={onNewSession}
          className={`h-11 w-full justify-start gap-2 ${collapsibleRow}`}
          aria-label="Start a new chat"
          title={collapsed ? "New chat" : undefined}
        >
          <MessageSquarePlus className="h-5 w-5 shrink-0" />
          <span className={collapsibleLabel}>New chat</span>
        </Button>
      </div>

      <ScrollArea className={`min-h-0 flex-1 ${collapsed ? "md:invisible" : ""}`}>
        <div className="space-y-1 p-3 pt-1">
          {sessions.length === 0 ? (
            <div className="py-4 text-center text-sm text-muted-foreground">
              No saved chats yet. Ask a question and it will be saved here.
            </div>
          ) : (
            sessions.map((session) => (
              <div key={session.id} className="group relative">
                <Button
                  asChild
                  variant={activeSession === session.id ? "secondary" : "ghost"}
                  className="h-auto w-full min-w-0 justify-start gap-2 px-3 py-2.5"
                >
                  <Link
                    href={`/${session.id}`}
                    onClick={() => onAfterSessionNavigate?.()}
                  >
                    <MessageSquare className="mt-0.5 h-4 w-4 shrink-0" />
                    <div className="min-w-0 flex-1 pr-10 text-left">
                      <div className="truncate text-sm font-medium">{session.title}</div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3 shrink-0" />
                        <span className="truncate">{formatTimestamp(session.timestamp)}</span>
                      </div>
                    </div>
                  </Link>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-1/2 h-11 w-11 -translate-y-1/2 transition-opacity focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
                  aria-label={`Delete chat: ${session.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    setDeleteConfirm(session.id);
                  }}
                >
                  <Trash2 className="h-4 w-4 text-destructive dark:text-red-400" />
                </Button>

                {deleteConfirm === session.id && (
                  <div className="absolute inset-y-0 right-0 z-10 flex w-full items-center justify-end gap-1 rounded-md bg-background/95 pr-2 backdrop-blur-sm">
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

      <div className={`border-t p-3 ${collapsed ? "md:flex md:flex-col md:items-center md:gap-1 md:space-y-0" : "space-y-1"}`}>
        <div
          className={`flex items-center gap-2 px-2 py-1.5 ${collapsed ? "md:justify-center md:px-0" : ""}`}
          title={collapsed ? displayName : undefined}
        >
          <span
            aria-hidden
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground"
          >
            {initial}
          </span>
          <span className={`min-w-0 flex-1 truncate text-sm ${collapsibleLabel}`}>
            {displayName}
          </span>
        </div>
        <Button
          asChild
          variant="ghost"
          className={`h-11 w-full justify-start gap-2 ${collapsibleRow}`}
          title={collapsed ? "Settings" : undefined}
        >
          <Link href="/settings/sessions" aria-label="Manage sessions">
            <Settings className="h-4 w-4 shrink-0" />
            <span className={collapsibleLabel}>Settings</span>
          </Link>
        </Button>
        <Button
          variant="ghost"
          onClick={() => void handleSignOut()}
          className={`h-11 w-full justify-start gap-2 text-red-700 hover:bg-red-700/10 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-400/10 dark:hover:text-red-400 ${collapsibleRow}`}
          aria-label="Sign out"
          title={collapsed ? "Sign out" : undefined}
        >
          <LogOut className="h-4 w-4 shrink-0" />
          <span className={collapsibleLabel}>Sign out</span>
        </Button>
      </div>
    </div>
  );
}
