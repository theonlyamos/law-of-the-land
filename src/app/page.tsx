"use client"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useState } from "react"
import ReactMarkdown from 'react-markdown'
import Image from 'next/image'
import logo from './logo-transparent.png'

export default function Home() {
  const [query, setQuery] = useState<string>("")
  const [result, setResult] = useState<string>("")
  const [isLoading, setIsLoading] = useState<boolean>(false)

  const onSubmit = async () => {
    if (query.length === 0) {
      return
    }
    setIsLoading(true)
    try {
      const response = await fetch('/api/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      })
      const data = await response.json()
      setResult(data)
    } catch (error) {
      console.error('Error:', error)
      setResult('An error occurred while fetching the data.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="container mx-auto">
      <div className="flex flex-col items-center justify-center min-h-screen">
        <div className="grid w-full max-w-3xl gap-4">
          <div className="flex justify-center mb-4">
            <Image
              src={logo}
              alt="Law of the Land Logo"
              width={200}
              height={200}
              priority
            />
          </div>
          <Textarea 
            placeholder="Type your query here." 
            onChange={(e) => setQuery(e.target.value)}
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
          {result && (
            <div className="mt-4 p-4 w-full max-w-3xl bg-gray-100 rounded prose">
              <ReactMarkdown>{result}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
