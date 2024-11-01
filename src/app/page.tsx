"use client"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Send } from "lucide-react"
import { useState, useCallback, useEffect, useRef } from "react"
import ReactMarkdown from 'react-markdown'
import Image from 'next/image'
import logo from './logo-transparent.png'
import githubLogo from './github-mark.png'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

export default function Home() {
  const [query, setQuery] = useState<string>("")
  const [messages, setMessages] = useState<Message[]>([])
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }

  // Scroll to bottom when messages change
  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const handleSearch = useCallback(async (searchQuery: string) => {
    if (!searchQuery.trim()) return;
    
    setIsLoading(true);
    // Add user message immediately
    setMessages(prev => [...prev, { role: 'user', content: searchQuery }]);
    // Start with empty assistant message
    setMessages(prev => [...prev, { role: 'assistant', content: '' }]);
    setQuery(''); // Clear input

    try {
        const eventSource = new EventSource(`/api/search?query=${encodeURIComponent(searchQuery)}`);

        eventSource.onmessage = (event) => {
            const data = event.data;
            if (data === '[DONE]') {
                eventSource.close();
                setIsLoading(false);
                return;
            }
            const formattedData = data.replace(/\\n/g, '\n');
            let count = 0;
            setMessages(prev => {
                const newMessages = [...prev];
                const lastMessage = newMessages[newMessages.length - 1];
                count++;
                if (lastMessage && lastMessage.role === 'assistant' && count === 1) {
                    lastMessage.content += formattedData;
                }
                return newMessages;
            });
        };

        eventSource.onerror = (error) => {
            console.error('EventSource error:', error);
            eventSource.close();
            setIsLoading(false);
            setMessages(prev => {
              const newMessages = [...prev];
              const lastMessage = newMessages[newMessages.length - 1];
              if (lastMessage && lastMessage.role === 'assistant') {
                lastMessage.content = 'An error occurred while processing your request.';
              }
              return newMessages;
            });
        };

        return () => {
            eventSource.close();
        };
    } catch (error) {
        console.error('Error:', error);
        setIsLoading(false);
        setMessages(prev => {
          const newMessages = [...prev];
          const lastMessage = newMessages[newMessages.length - 1];
          if (lastMessage && lastMessage.role === 'assistant') {
            lastMessage.content = 'An error occurred while processing your request.';
          }
          return newMessages;
        });
    }
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSearch(query);
    }
  }, [query, handleSearch]);

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
      <ScrollArea className="flex-1 p-4" ref={scrollAreaRef}>
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center text-gray-500">
            <Image
              src={logo}
              alt="Law of the Land Logo"
              width={120}
              priority
            />
            <p className="max-w-md mt-2">
              Law of the Land transforms complex laws and regulations into clear, understandable answers. 
              Ask a question about your rights or local laws to get started.
            </p>
          </div>
        ) : (
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
        )}
      </ScrollArea>

      {/* Updated Input Area */}
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
    </div>
  )
}
