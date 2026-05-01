"use client";

import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Menu, Check } from "lucide-react";
import { useState, useCallback, useEffect, useRef, Suspense } from "react";
import ReactMarkdown from 'react-markdown';
import Image from 'next/image';
import logo from './logo-transparent.png';
import githubLogo from './github-mark.png';
import axios from 'axios';
import { Sidebar } from "@/components/ui/sidebar";
import { ChatInput } from "@/components/ui/chat-input";
import { LandingPage } from "@/components/landing-page";

interface Message {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt?: Date;
  updatedAt?: Date;
}

interface ChatSession {
  id: string;
  title: string;
  lastMessage: string;
  timestamp: Date;
  messageCount: number;
  messages: Message[];
}

interface StoredMessage extends Omit<Message, 'createdAt' | 'updatedAt'> {
  createdAt?: string;
  updatedAt?: string;
}

interface StoredChatSession extends Omit<ChatSession, 'timestamp' | 'messages'> {
  timestamp: string;
  messages: StoredMessage[];
}

const SUGGESTED_QUESTIONS = [
  "What are my rights as a tenant?",
  "Can I get a refund for a defective product?",
  "What should I do if I get a speeding ticket?",
  "What are the rules for returning items to stores?",
  "What are my rights at work?"
];

function Chat() {
  const [query, setQuery] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSession, setActiveSession] = useState<string | undefined>();
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(false);
  const [hasStartedChat, setHasStartedChat] = useState<boolean>(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load chat sessions from localStorage after initial render
  useEffect(() => {
    const saved = localStorage.getItem('chatSessions');
    if (saved) {
      const loadedSessions = JSON.parse(saved).map((session: StoredChatSession) => ({
        ...session,
        timestamp: new Date(session.timestamp),
        messages: session.messages.map((msg: StoredMessage) => ({
          ...msg,
          createdAt: msg.createdAt ? new Date(msg.createdAt) : undefined,
          updatedAt: msg.updatedAt ? new Date(msg.updatedAt) : undefined
        }))
      }));
      setSessions(loadedSessions);
      if (loadedSessions.length > 0) {
        setActiveSession(loadedSessions[0].id);
        setMessages(loadedSessions[0].messages);
        setHasStartedChat(true);
      }
    }
  }, []);

  // Effect to handle initial sidebar state based on screen size
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth >= 768) {
        setIsSidebarOpen(true);
      } else {
        setIsSidebarOpen(false);
      }
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSearch = useCallback(async (searchQuery: string) => {
    if (!searchQuery.trim()) return;

    if (!hasStartedChat) {
      setHasStartedChat(true);
    }

    const userMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: searchQuery
    } as Message;

    if (!activeSession) {
      const newSessionId = crypto.randomUUID();
      const newSession: ChatSession = {
        id: newSessionId,
        title: searchQuery.slice(0, 30) + (searchQuery.length > 30 ? '...' : ''),
        lastMessage: searchQuery,
        timestamp: new Date(),
        messageCount: 1,
        messages: [userMessage]
      };
      setSessions(prev => [newSession, ...prev]);
      setActiveSession(newSessionId);
      setMessages(newSession.messages);
      localStorage.setItem('chatSessions', JSON.stringify([newSession, ...sessions]));
    }

    let newMessages: Message[] = [];
    setMessages(prev => {
      newMessages = [...prev];
      const loaderMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '...'
      } as Message;

      if (activeSession) {
        newMessages.push(userMessage, loaderMessage);
      } else {
        newMessages.push(loaderMessage);
      }
      return newMessages;
    });

    try {
      const { data: searchData } = await axios.post('/api/search', { query: searchQuery });
      const context = searchData.result;

      const { data: chatData } = await axios.post('/api/chat', {
        query: searchQuery,
        messages: messages.slice(-10),
        context
      });

      setIsLoading(false);
      setMessages(prev => {
        newMessages = [...prev];
        newMessages.pop();
        newMessages.push({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: chatData.result
        } as Message);
        return newMessages;
      });

      setSessions(prev => {
        const newSessions = prev.map(session => {
          if (session.id === activeSession) {
            return {
              ...session,
              lastMessage: chatData.result,
              messageCount: newMessages.length,
              messages: newMessages,
              timestamp: new Date()
            };
          }
          return session;
        });
        localStorage.setItem('chatSessions', JSON.stringify(newSessions));
        return newSessions;
      });
    } catch (error) {
      console.error('Error:', error);
      setIsLoading(false);
      setMessages(prev => {
        newMessages = [...prev];
        newMessages.pop();
        newMessages.push({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: 'Sorry, something went wrong. Please try again or rephrase your question.'
        } as Message);
        return newMessages;
      });
    }
  }, [messages, activeSession, sessions, hasStartedChat]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSearch(query);
      setQuery('');
    }
  }, [query, handleSearch]);

  const handleNewSession = useCallback(() => {
    setMessages([]);
    setActiveSession(undefined);
    setHasStartedChat(false);
  }, []);

  const handleSessionSelect = useCallback((sessionId: string) => {
    setActiveSession(sessionId);
    const selectedSession = sessions.find(session => session.id === sessionId);
    if (selectedSession) {
      setMessages(selectedSession.messages);
    }
  }, [sessions]);

  const handleDeleteSession = useCallback((sessionId: string) => {
    setSessions(prev => {
      const newSessions = prev.filter(session => session.id !== sessionId);
      localStorage.setItem('chatSessions', JSON.stringify(newSessions));

      if (sessionId === activeSession) {
        setActiveSession(undefined);
        setMessages([]);
        if (newSessions.length === 0) {
          setHasStartedChat(false);
        }
      } else {
        if (newSessions.length === 0) {
          setHasStartedChat(false);
        }
      }

      return newSessions;
    });
  }, [activeSession]);

  const handleSuggestedQuestion = useCallback((question: string) => {
    setQuery(question);
    handleSearch(question);
    setQuery('');
    if (window.innerWidth < 768) setIsSidebarOpen(false);
  }, [handleSearch]);

  const toggleSidebar = useCallback(() => {
    setIsSidebarOpen(prev => !prev);
  }, []);

  return (
    <div className="container mx-auto relative h-screen flex overflow-hidden">
      {/* Overlay for mobile sidebar */}
      {isSidebarOpen && (
        <div
          className="fixed inset-0 bg-background/80 backdrop-blur-sm z-40 md:hidden transition-opacity duration-300"
          onClick={toggleSidebar}
        />
      )}

      {/* Sidebar - only show when chat has started */}
      {hasStartedChat && (
        <Sidebar
          sessions={sessions}
          activeSession={activeSession}
          isOpen={isSidebarOpen}
          onSessionSelect={(sessionId) => {
            handleSessionSelect(sessionId);
            if (window.innerWidth < 768) setIsSidebarOpen(false);
          }}
          onNewSession={() => {
            handleNewSession();
            if (window.innerWidth < 768) setIsSidebarOpen(false);
          }}
          onDeleteSession={handleDeleteSession}
          onClose={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Main Area */}
      <div className={`flex-1 flex flex-col transition-all duration-300 ease-in-out ${
        hasStartedChat && isSidebarOpen && window.innerWidth >= 768 ? 'md:ml-64' : 'ml-0'
      }`}>
        {/* Header - only show when chat has started */}
        {hasStartedChat && (
          <div className="flex items-center justify-between gap-4 p-4 border-b">
            <div className="flex items-center gap-4">
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleSidebar}
                className="md:hidden h-11 w-11"
              >
                <Menu className="h-5 w-5" />
              </Button>
              <Image
                src={logo}
                alt="Law of the Land Logo"
                width={80}
                priority
              />
              <div>
                <h1 className="text-xl font-bold">Law of the Land</h1>
                <p className="text-sm text-muted-foreground">Your AI legal research assistant</p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <a href="https://github.com/theonlyamos/law-of-the-land" target="_blank" rel="noopener noreferrer">
                <Image
                  src={githubLogo}
                  alt="GitHub"
                  width={32}
                  height={32}
                />
              </a>
            </div>
          </div>
        )}

        {/* Conditional rendering: Landing Page vs Chat Interface */}
        {!hasStartedChat ? (
          <LandingPage
            query={query}
            onQueryChange={setQuery}
            onSearch={() => handleSearch(query)}
            onKeyDown={handleKeyDown}
            isLoading={isLoading}
          />
        ) : (
          <>
            <ScrollArea className="flex-1 p-4" ref={scrollAreaRef}>
              <div className="space-y-4">
                {messages.map((message, index) => {
                  const prevRole = index > 0 ? messages[index - 1].role : null;
                  const isNewSpeaker = prevRole && prevRole !== message.role;

                  return (
                    <div
                      key={index}
                      className={`flex gap-2 md:gap-3 ${
                        message.role === 'user' ? 'justify-end' : 'justify-start'
                      } ${isNewSpeaker ? 'mt-6' : ''}`}
                    >
                      {message.role === 'assistant' && (
                        <Avatar className="w-8 h-8 md:w-10 md:h-10">
                          <AvatarFallback>AI</AvatarFallback>
                        </Avatar>
                      )}
                      <div
                        className={`rounded-lg p-3 md:p-4 max-w-[75%] lg:max-w-[65%] shadow-sm ${
                          message.role === 'user'
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted text-foreground'
                        }`}
                      >
                        {message.role === 'assistant' ? (
                          <div className="text-sm leading-relaxed markdown-content">
                            {message.content === '...' ? (
                              <div className="flex gap-1 p-2">
                                <div className="w-2 h-2 bg-primary/60 rounded-full animate-bounce [animation-delay:0ms]" />
                                <div className="w-2 h-2 bg-primary/60 rounded-full animate-bounce [animation-delay:150ms]" />
                                <div className="w-2 h-2 bg-primary/60 rounded-full animate-bounce [animation-delay:300ms]" />
                              </div>
                            ) : (
                              <ReactMarkdown>{message.content}</ReactMarkdown>
                            )}
                          </div>
                        ) : (
                          <p className="text-sm leading-relaxed">{message.content}</p>
                        )}
                      </div>
                      {message.role === 'user' && (
                        <Avatar className="w-8 h-8 md:w-10 md:h-10">
                          <AvatarFallback>ME</AvatarFallback>
                        </Avatar>
                      )}
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>
            </ScrollArea>

            {/* Input area for when messages exist */}
            <div className="p-4 border-t">
              <ChatInput
                query={query}
                onQueryChange={setQuery}
                onSearch={() => handleSearch(query)}
                onKeyDown={handleKeyDown}
                isLoading={isLoading}
                rows={4}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <Suspense fallback={
      <div className="container mx-auto relative h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center">
          <p className="text-lg font-semibold mt-4">Loading your legal assistant...</p>
          <div className="mt-2 w-16 h-16 border-4 border-primary border-dashed rounded-full animate-spin"></div>
        </div>
      </div>
    }>
      <Chat />
    </Suspense>
  )
}
