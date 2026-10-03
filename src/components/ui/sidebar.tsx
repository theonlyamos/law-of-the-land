"use client";

import { ProfileMenu } from "./profile-menu";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ChatSession } from "@/lib/chat-sessions";
import { api } from "@/convex/_generated/api";
import { authClient } from "@/lib/auth-client";
import { useConvexAuth, useQuery } from "convex/react";
import {
  PanelLeft,
  Plus,
  SquarePen,
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
  sessionPaginationStatus: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
  activeSession?: string;
  /** Mobile drawer state (< md). */
  isOpen: boolean;
  /** Desktop icon-rail state (>= md). */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onAfterSessionNavigate?: () => void;
  onNewSession: () => void;
  onLoadMoreSessions: () => void;
  onDeleteSession: (sessionId: string) => void;
  onClose: () => void;
}

export function Sidebar({
  sessions,
  sessionPaginationStatus,
  activeSession,
  isOpen,
  collapsed = false,
  onToggleCollapse,
  onAfterSessionNavigate,
  onNewSession,
  onLoadMoreSessions,
  onDeleteSession,
  onClose,
}: SidebarProps) {
  const router = useRouter();
  const { isAuthenticated } = useConvexAuth();
  const user = useQuery(api.users.current, isAuthenticated ? {} : "skip");
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const displayName = user?.name ?? user?.email ?? "Account";

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 7);
  const sessionGroups: Record<string, ChatSession[]> = {
    Today: [],
    Yesterday: [],
    "Previous 7 days": [],
    Older: [],
  };
  for (const session of sessions) {
    const group = session.timestamp >= today ? "Today"
      : session.timestamp >= yesterday ? "Yesterday"
      : session.timestamp >= weekAgo ? "Previous 7 days" : "Older";
    sessionGroups[group].push(session);
  }

  const handleSignOut = async () => {
    const result = await authClient.signOut();
    if (result.error) throw new Error("Sign out failed");
    router.push("/");
  };

  const collapsibleLabel = collapsed ? "md:hidden" : "";
  const collapsibleRow = collapsed ? "md:h-11 md:w-11 md:justify-center md:px-0" : "";

  return (
    <div
      aria-label="Chat history"
      className={`
        flex h-full min-h-0 w-60 shrink-0 flex-col border-r bg-[hsl(var(--chat-panel))]
        fixed inset-y-0 left-0 z-50 transform
        transition-[transform,visibility] duration-200 ease-out motion-reduce:transition-none
        md:static md:z-20 md:translate-x-0 md:visible
        ${isOpen ? "visible translate-x-0" : "invisible -translate-x-full"}
        ${collapsed ? "md:w-[4.25rem]" : "md:w-60"}
      `}
    >
      <div className={`flex items-center px-3 pb-5 pt-4 ${collapsed ? "md:flex-col md:gap-2" : ""}`}>
        <Link
          href="/"
          aria-label="Law of the Land — home"
          className="flex h-11 w-11 shrink-0 items-center justify-center"
        >
          <Image src={logo} alt="" width={34} />
        </Link>
        <span
          className={`min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight ${collapsibleLabel}`}
        >
          Law of the Land
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleCollapse}
          className="hidden h-11 w-11 shrink-0 text-muted-foreground md:flex"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
        >
          <PanelLeft className="h-4 w-4" />
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

      <div className="px-3 pb-6">
        <Button
          variant="outline"
          onClick={onNewSession}
          className={`h-11 w-full justify-start gap-2.5 rounded-full border-border bg-card px-4 text-[13px] shadow-none ${collapsibleRow}`}
          aria-label="Start a new chat"
          title={collapsed ? "New chat" : undefined}
        >
          <Plus className="h-4 w-4 shrink-0" />
          <span className={collapsibleLabel}>New chat</span>
          <SquarePen className={`ml-auto h-4 w-4 text-muted-foreground ${collapsibleLabel}`} />
        </Button>
      </div>

      <ScrollArea className={`min-h-0 flex-1 ${collapsed ? "md:invisible" : ""}`}>
        <div className="space-y-6 px-3 pb-4">
          {sessionPaginationStatus === "LoadingFirstPage" ? (
            <p className="py-4 text-center text-sm text-muted-foreground">Loading chats…</p>
          ) : sessions.length === 0 ? (
            <div className="py-4 text-center text-sm text-muted-foreground">
              No saved chats yet. Ask a question and it will be saved here.
            </div>
          ) : (
            Object.entries(sessionGroups).filter(([, group]) => group.length > 0).map(([label, group]) => (
              <section key={label} aria-label={label}>
                <h2 className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</h2>
                {group.map((session) => (
                  <div key={session.id} className="group relative">
                    <Button
                      asChild
                      variant={activeSession === session.id ? "secondary" : "ghost"}
                      className="h-11 w-full min-w-0 justify-start rounded-lg px-3 pr-11 shadow-none"
                    >
                      <Link
                        href={`/${session.id}`}
                        aria-current={activeSession === session.id ? "page" : undefined}
                        title={`${session.title} · ${session.timestamp.toLocaleDateString()}`}
                        onClick={() => onAfterSessionNavigate?.()}
                      >
                        <span className="min-w-0 flex-1 truncate text-left text-[13px] font-normal">{session.title}</span>
                      </Link>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute right-0 top-1/2 h-11 w-11 -translate-y-1/2 text-muted-foreground transition-opacity hover:text-destructive focus-visible:opacity-100 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
                      aria-label={`Delete chat: ${session.title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        setDeleteConfirm(session.id);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>

                    {deleteConfirm === session.id && (
                      <div className="absolute inset-y-0 right-0 z-10 flex w-full items-center justify-end gap-1 rounded-lg bg-background pr-1">
                        <Button
                          size="sm"
                          variant="destructive"
                          className="h-11"
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
                          className="h-11"
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
                ))}
              </section>
            ))
          )}
          {sessions.length > 0 && (
            <div className="pt-2">
              {sessionPaginationStatus === "CanLoadMore" && (
                <Button
                  variant="ghost"
                  className="h-11 w-full text-xs text-muted-foreground"
                  onClick={onLoadMoreSessions}
                >
                  Load more chats
                </Button>
              )}
              {sessionPaginationStatus === "LoadingMore" && (
                <p className="py-2 text-center text-xs text-muted-foreground" aria-live="polite">
                  Loading more chats…
                </p>
              )}
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="border-t p-3">
        <ProfileMenu name={displayName} image={user?.image} caption="Account settings" collapsed={collapsed} onNavigate={onAfterSessionNavigate} onSignOut={handleSignOut} />
      </div>
    </div>
  );
}
