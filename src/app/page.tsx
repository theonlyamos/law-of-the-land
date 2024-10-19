"use client"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useState, useCallback } from "react"
import ReactMarkdown from 'react-markdown'
import Image from 'next/image'
import logo from './logo-transparent.png'
import githubLogo from './github-mark.png'

export default function Home() {
  const [query, setQuery] = useState<string>("")
  const [result, setResult] = useState<string>("")
  const [isLoading, setIsLoading] = useState<boolean>(false)

  const onSubmit = useCallback(async () => {
    if (query.length === 0) {
      return
    }
    setResult('')
    setIsLoading(true)
    try {
      const response = await fetch(`/api/search?query=${encodeURIComponent(query)}`)
      const data = await response.text()
      setResult(data)
    } catch (error) {
      console.error('Error:', error)
      setResult('An error occurred while fetching the data.')
    } finally {
      setIsLoading(false)
    }
  }, [query])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      onSubmit();
    }
  }, [onSubmit]);

  return (
    <div className="container mx-auto relative">
      <div className="absolute top-4 right-4">
        <a href="https://github.com/theonlyamos/law-of-the-land" target="_blank" rel="noopener noreferrer">
          <Image
            src={githubLogo}
            alt="GitHub"
            width={32}
            height={32}
          />
        </a>
      </div>
      <div className="flex flex-col items-center justify-center min-h-screen">
        <div className="grid w-full max-w-3xl gap-4">
          <div className="flex justify-center">
            <Image
              src={logo}
              alt="Law of the Land Logo"
              width={200}
              height={200}
              priority
            />
          </div>
          <p className="text-md mb-3">
            Law of the Land is an AI-powered legal assistant that transforms complex laws and regulations into clear, understandable answers. Simply ask a question about your rights or local laws, and get accurate responses backed by official legal documents.
          </p>
          <Textarea 
            placeholder="Type your query here." 
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            value={query}
            disabled={isLoading}
            className="h-32 resize-none"
          />
          <Button 
            onClick={onSubmit} 
            disabled={isLoading}
            className="h-12 text-lg"
          >
            {isLoading ? 'Searching...' : 'Search'}
          </Button>
          {isLoading ? (
            <div className="mt-4 p-4 w-full max-w-3xl bg-gray-100 rounded animate-pulse">
              <div className="h-4 bg-gray-300 rounded w-3/4 mb-2"></div>
              <div className="h-4 bg-gray-300 rounded w-1/2 mb-2"></div>
              <div className="h-4 bg-gray-300 rounded w-5/6 mb-2"></div>
              <div className="h-4 bg-gray-300 rounded w-2/3 mb-2"></div>
              <div className="h-4 bg-gray-300 rounded w-3/4"></div>
            </div>
          ) : result && (
            <div className="mt-4 p-4 w-full max-w-3xl bg-gray-100 rounded prose">
              <ReactMarkdown>{result}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
