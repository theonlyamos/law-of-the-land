"use client"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useState } from "react"

export default function Home() {
  const [query, setQuery] = useState<string>("")
  const [result, setResult] = useState<string>("")

  const onSubmit = async () => {
    try {
      const response = await fetch('/api/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      })
      const data = await response.json()
      console.log(data)
      setResult(JSON.stringify(data, null, 2))
    } catch (error) {
      console.error('Error:', error)
      setResult('An error occurred while fetching the data.')
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="grid w-full max-w-md gap-2">
        <Textarea 
          placeholder="Type your message here." 
          onChange={(e) => setQuery(e.target.value)}
          value={query}
        />
        <Button onClick={onSubmit}>Send message</Button>
        {result && (
          <pre className="mt-4 p-2 bg-gray-100 rounded">
            {result}
          </pre>
        )}
      </div>
    </div>
  )
}
