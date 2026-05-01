import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Clock, MessageSquare, MessageSquarePlus, Trash2, X, AlertTriangle } from "lucide-react";
import { useState } from "react";

interface ChatSession {
  id: string;
  title: string;
  lastMessage: string;
  timestamp: Date;
  messageCount: number;
}

interface SidebarProps {
  sessions: ChatSession[];
  activeSession?: string;
  isOpen: boolean;
  onSessionSelect: (sessionId: string) => void;
  onNewSession: () => void;
  onDeleteSession: (sessionId: string) => void;
  onClose: () => void;
}

export function Sidebar({ sessions, activeSession, isOpen, onSessionSelect, onNewSession, onDeleteSession, onClose }: SidebarProps) {
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  
  const formatTimestamp = (date: Date) => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    
    if (days === 0) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (days === 1) {
      return 'Yesterday';
    } else if (days < 7) {
      return date.toLocaleDateString([], { weekday: 'long' });
    } else {
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
  };

  return (
    <div 
      className={`
        w-64 h-full border-r bg-background flex flex-col 
        fixed md:static z-50 md:z-auto 
        transform ${isOpen ? "translate-x-0" : "-translate-x-full"} 
        md:translate-x-0 transition-transform duration-300 ease-in-out
      `}
    >
      <div className="p-4 border-b">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Conversations</h2>
          <div className="flex items-center">
            <Button
              variant="ghost"
              size="icon"
              onClick={onNewSession}
              className="h-11 w-11"
            >
              <MessageSquarePlus className="h-5 w-5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="h-11 w-11 md:hidden ml-2"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
      
      <ScrollArea className="flex-1">
        <div className="p-3 space-y-1">
          {sessions.length === 0 ? (
            <div className="text-center text-muted-foreground py-4">
              No conversations yet. Start a new chat to get started.
            </div>
          ) : (
            sessions.map((session, index) => (
              <div
                key={session.id}
                className={`group relative border-b border-border/50 last:border-b-0 pb-1 ${index > 0 ? 'pt-1' : ''}`}
              >
                <Button
                  variant={activeSession === session.id ? "secondary" : "ghost"}
                  className="w-full justify-start gap-2 h-auto py-3 px-4"
                  onClick={() => onSessionSelect(session.id)}
                >
                  <MessageSquare className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  <div className="flex-1 text-left min-w-0">
                    <div className="font-medium truncate text-sm">{session.title}</div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
                      <Clock className="h-3 w-3 flex-shrink-0" />
                      <span className="truncate">{formatTimestamp(session.timestamp)}</span>
                    </div>
                  </div>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteConfirm(session.id);
                  }}
                >
                  <Trash2 className="h-3 w-3 text-destructive" />
                </Button>
                
                {/* Delete Confirmation Dialog */}
                {deleteConfirm === session.id && (
                  <div className="absolute inset-0 bg-background/95 backdrop-blur-sm flex items-center justify-center p-2 z-10">
                    <div className="text-center">
                      <AlertTriangle className="h-6 w-6 text-destructive mx-auto mb-2" />
                      <p className="text-xs font-medium mb-2">Delete this conversation?</p>
                      <div className="flex gap-1">
                        <Button 
                          size="sm" 
                          variant="destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteSession(session.id);
                            setDeleteConfirm(null);
                          }}
                        >
                          Delete
                        </Button>
                        <Button 
                          size="sm" 
                          variant="ghost"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteConfirm(null);
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
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