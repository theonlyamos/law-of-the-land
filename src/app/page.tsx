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
import { io, Socket } from "socket.io-client"

interface Message {
  id?: string
  role: 'user' | 'assistant'
  content: string
  createdAt?: Date
  updatedAt?: Date
}

function Chat() {
  const socketRef = useRef<Socket | null>(null)
  
  const [query, setQuery] = useState<string>("")
  const [messages, setMessages] = useState<Message[]>([])
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Load chat history from localStorage after initial render
  useEffect(() => {
    const saved = localStorage.getItem('chatHistory')
    if (saved) {
      setMessages(JSON.parse(saved))
    }
  }, [])

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }

  // Scroll to bottom when messages change
  useEffect(() => {
    scrollToBottom()
  }, [messages])

  // Initialize Socket.IO connection
  useEffect(() => {
    const initSocket = async () => {
      socketRef.current = io({
        path: '/api/socketio'
      })

      socketRef.current.on('search:start', ({ query }) => {
        setIsLoading(true)
        setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'user', content: query }])
        setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: '' }])
        setQuery('')
      })

      socketRef.current.on('search:complete', ({ result }) => {
        setIsLoading(false)
        setMessages(prev => {
          const newMessages = [...prev]
          newMessages.pop()
          newMessages.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: result
          } as Message)
          localStorage.setItem('chatHistory', JSON.stringify(newMessages))
          return newMessages
        })
      })

      socketRef.current.on('search:error', ({ error }) => {
        setIsLoading(false)
        setMessages(prev => {
          const newMessages = [...prev]
          newMessages.pop()
          newMessages.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: error
          } as Message)
          localStorage.setItem('chatHistory', JSON.stringify(newMessages))
          return newMessages
        })
      })

      return () => {
        if (socketRef.current) {
          socketRef.current.disconnect()
        }
      }
    }

    initSocket()
  }, [])

  const handleSearch = useCallback(async (searchQuery: string) => {
    if (!searchQuery.trim()) return
    
    // router.push(`/?query=${encodeURIComponent(searchQuery)}`)
    setMessages(prev => {
      const newMessages = [...prev]
      const userMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: searchQuery
      } as Message

      const loaderMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '...'
      } as Message

      newMessages.push(userMessage, loaderMessage)
      
      localStorage.setItem('chatHistory', JSON.stringify(newMessages))
      return newMessages
    })

    try {
      // First emit the search:start event
      socketRef.current?.emit('search:start', { query: searchQuery })
      
      // Then emit the search request
      socketRef.current?.emit('search:request', {
        query: searchQuery,
        messages: messages.slice(-10)
      })
    } catch (error) {
      console.error('Error:', error)
      setIsLoading(false)
      setMessages(prev => {
        const newMessages = [...prev]
        newMessages.pop()
        newMessages.push({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: 'An error occurred while processing your request.'
        } as Message)
        localStorage.setItem('chatHistory', JSON.stringify(newMessages))
        return newMessages
      })
    }
  }, [messages])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSearch(query);
      setQuery('');
    }
  }, [query, handleSearch]);

  const clearHistory = useCallback(() => {
    setMessages([]);
    localStorage.removeItem('chatHistory');
  }, []);

  return (
    <div className="container mx-auto relative h-screen flex flex-col"> 
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
          <button
            onClick={clearHistory}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            Clear History
          </button>
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

      {/* Chat Area - Modified to handle empty state differently */}
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
          
          {/* Input area for empty state */}
          <div className="w-full max-w-2xl">
            <div className="relative flex items-center">
              <Textarea 
                placeholder="Type your question here... (Press Enter to send)" 
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                value={query}
                disabled={isLoading}
                className="resize-none pr-14 min-h-[56px] max-h-[200px]"
                rows={1}
              />
              <Button 
                onClick={() => handleSearch(query)} 
                disabled={isLoading}
                size="icon"
                className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8"
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
                      {/* <AvatarImage src="/bot-avatar.png" /> */}
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
                      {/* <AvatarImage src="/user-avatar.png" /> */}
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
                className="resize-none pr-14 min-h-[56px] max-h-[200px]"
                rows={1}
              />
              <Button 
                onClick={() => handleSearch(query)} 
                disabled={isLoading}
                size="icon"
                className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8"
              >
                <Send className={`h-5 w-5 ${isLoading ? 'animate-pulse' : ''}`} />
                <span className="sr-only">Send message</span>
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
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
