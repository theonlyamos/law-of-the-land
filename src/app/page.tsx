"use client"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Send } from "lucide-react"
import { useState, useCallback, useEffect, useRef, Suspense } from "react"
import ReactMarkdown from 'react-markdown'
import Image from 'next/image'
import logo from './logo-transparent.png'
import githubLogo from './github-mark.png'
import axios from 'axios'
import { Sidebar } from "@/components/ui/sidebar"

interface Message {
  id?: string
  role: 'user' | 'assistant'
  content: string
  createdAt?: Date
  updatedAt?: Date
}

interface ChatSession {
  id: string
  title: string
  lastMessage: string
  timestamp: Date
  messageCount: number
  messages: Message[]
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
  const [query, setQuery] = useState<string>("")
  const [messages, setMessages] = useState<Message[]>([])
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSession, setActiveSession] = useState<string | undefined>()
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Load chat sessions from localStorage after initial render
  useEffect(() => {
    const saved = localStorage.getItem('chatSessions')
    if (saved) {
      const loadedSessions = JSON.parse(saved).map((session: StoredChatSession) => ({
        ...session,
        timestamp: new Date(session.timestamp),
        messages: session.messages.map((msg: StoredMessage) => ({
          ...msg,
          createdAt: msg.createdAt ? new Date(msg.createdAt) : undefined,
          updatedAt: msg.updatedAt ? new Date(msg.updatedAt) : undefined
        }))
      }))
      setSessions(loadedSessions)
      if (loadedSessions.length > 0) {
        setActiveSession(loadedSessions[0].id)
        setMessages(loadedSessions[0].messages)
      }
    }
  }, [])

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }

  // Scroll to bottom when messages change
  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const handleSearch = useCallback(async (searchQuery: string) => {
    if (!searchQuery.trim()) return
    
    const userMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: searchQuery
    } as Message

    // If no active session, create a new one
    if (!activeSession) {
      const newSessionId = crypto.randomUUID()
      const newSession: ChatSession = {
        id: newSessionId,
        title: searchQuery.slice(0, 30) + (searchQuery.length > 30 ? '...' : ''),
        lastMessage: searchQuery,
        timestamp: new Date(),
        messageCount: 1,
        messages: [userMessage]
      }
      setSessions(prev => [newSession, ...prev])
      setActiveSession(newSessionId)
      setMessages(newSession.messages)
      localStorage.setItem('chatSessions', JSON.stringify([newSession, ...sessions]))
    }
    
    let newMessages: Message[] = []
    setMessages(prev => {
      newMessages = [...prev]
      const loaderMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '...'
      } as Message

      if (activeSession) {
        newMessages.push(userMessage, loaderMessage)
      } else {
        newMessages.push(loaderMessage)
      }
      return newMessages
    })

    try {
      // First get RAG context
      const { data: searchData } = await axios.post('/api/search', { query: searchQuery })
      const context = searchData.result
      
      // Then get the chat response
      const { data: chatData } = await axios.post('/api/chat', {
        query: searchQuery,
        messages: messages.slice(-10),
        context
      })

      setIsLoading(false)
      setMessages(prev => {
        newMessages = [...prev]
        newMessages.pop()
        newMessages.push({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: chatData.result
        } as Message)
        return newMessages
      })

      // Update the active session with the new messages
      setSessions(prev => {
        const newSessions = prev.map(session => {
          if (session.id === activeSession) {
            return {
              ...session,
              lastMessage: chatData.result,
              messageCount: newMessages.length,
              messages: newMessages,
              timestamp: new Date()
            }
          }
          return session
        })
        localStorage.setItem('chatSessions', JSON.stringify(newSessions))
        return newSessions
      })
    } catch (error) {
      console.error('Error:', error)
      setIsLoading(false)
      setMessages(prev => {
        newMessages = [...prev]
        newMessages.pop()
        newMessages.push({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: 'An error occurred while processing your request.'
        } as Message)
        return newMessages
      })
    }
  }, [messages, activeSession, sessions])

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
      
      // If the deleted session was active, clear the messages and active session
      if (sessionId === activeSession) {
        setActiveSession(undefined);
        setMessages([]);
      }
      
      return newSessions;
    });
  }, [activeSession]);

  const handleSuggestedQuestion = useCallback((question: string) => {
    setQuery(question);
    handleSearch(question);
    setQuery(''); // Clear the textarea after submitting
  }, [handleSearch]);

  return (
    <div className="container mx-auto relative h-screen flex"> 
      {/* Sidebar */}
      <Sidebar
        sessions={sessions}
        activeSession={activeSession}
        onSessionSelect={handleSessionSelect}
        onNewSession={handleNewSession}
        onDeleteSession={handleDeleteSession}
      />

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between gap-4 p-4 border-b">
          <div className="flex items-center gap-4">
            <Image
              src={logo}
              alt="Law of the Land Logo"
              width={80}
              priority
            />
            <div>
              <h1 className="text-xl font-bold">Law of the Land</h1>
              <p className="text-sm text-gray-500">AI-powered legal assistant</p>
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

        {/* Chat Area */}
        {messages.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-4">
            <Image
              src={logo}
              alt="Law of the Land Logo"
              width={120}
              priority
            />
            <p className="max-w-md mt-2 text-center text-gray-500 mb-8">
              Law of the Land transforms complex laws and regulations into clear, understandable answers. 
              Ask a question about your rights or local laws to get started.
            </p>
            
            {/* Suggested Questions */}
            <div className="w-full max-w-2xl mb-8">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {SUGGESTED_QUESTIONS.map((question, index) => (
                  <Button
                    key={index}
                    variant="outline"
                    className="justify-start text-left h-auto py-2 px-4"
                    onClick={() => handleSuggestedQuestion(question)}
                  >
                    {question}
                  </Button>
                ))}
              </div>
            </div>
            
            {/* Input area for empty state */}
            <div className="w-full max-w-2xl">
              <div className="relative flex items-center">
                <Textarea 
                  placeholder="Type your question here... (Press Enter to send)" 
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={handleKeyDown}
                  value={query}
                  disabled={isLoading}
                  className="resize-none pr-14 min-h-[56px] max-h-[200px] scrollbar-hide"
                  rows={1}
                />
                <Button 
                  onClick={() => handleSearch(query)} 
                  disabled={isLoading || !query.trim()}
                  size="icon"
                  className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Send className={`h-5 w-5 ${isLoading ? 'animate-pulse' : ''}`} />
                  <span className="sr-only">Send message</span>
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <ScrollArea className="flex-1 p-4" ref={scrollAreaRef}>
              <div className="space-y-4">
                {messages.map((message, index) => (
                  <div
                    key={index}
                    className={`flex gap-3 ${
                      message.role === 'user' ? 'justify-end' : 'justify-start'
                    }`}
                  >
                    {message.role === 'assistant' && (
                      <Avatar>
                        <AvatarFallback>AI</AvatarFallback>
                      </Avatar>
                    )}
                    <div
                      className={`rounded-lg p-4 max-w-[80%] ${
                        message.role === 'user'
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-gray-100 dark:bg-gray-800 text-foreground'
                      }`}
                    >
                      {message.role === 'assistant' ? (
                        <div className="prose prose-sm dark:prose-invert max-w-none">
                          <ReactMarkdown>{message.content || '...'}</ReactMarkdown>
                        </div>
                      ) : (
                        <p>{message.content}</p>
                      )}
                    </div>
                    {message.role === 'user' && (
                      <Avatar>
                        <AvatarFallback>ME</AvatarFallback>
                      </Avatar>
                    )}
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>
            </ScrollArea>

            {/* Input area for when messages exist */}
            <div className="p-4 border-t">
              <div className="relative flex items-center">
                <Textarea 
                  placeholder="Type your question here... (Press Enter to send)" 
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={handleKeyDown}
                  value={query}
                  disabled={isLoading}
                  className="resize-none pr-14 min-h-[56px] max-h-[200px] scrollbar-hide"
                  rows={1}
                  style={{
                    scrollbarWidth: 'none',
                    msOverflowStyle: 'none'
                  }}
                />
                <Button 
                  onClick={() => handleSearch(query)} 
                  disabled={isLoading || !query.trim()}
                  size="icon"
                  className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Send className={`h-5 w-5 ${isLoading ? 'animate-pulse' : ''}`} />
                  <span className="sr-only">Send message</span>
                </Button>
              </div>
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
      <div className="container mx-auto relative h-screen flex items-center justify-center">
        <p>Loading...</p>
      </div>
    }>
      <Chat />
    </Suspense>
  )
}
