'use client'

import { useEffect } from 'react'
import './globals.css'

// Replaces the root layout when it crashes, so it must render its own
// <html>/<body> and stay dependency-light.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <html lang="en">
      <body className="antialiased">
        <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 text-center">
          <div>
            <h1 className="mb-4 text-4xl font-bold">Something went wrong</h1>
            <p className="text-xl text-muted-foreground">
              An unexpected error stopped the page. Your saved chats are not affected.
            </p>
            {error.digest && (
              <p className="mt-2 text-sm text-muted-foreground">
                Reference code: {error.digest}
              </p>
            )}
          </div>
          <button
            onClick={() => reset()}
            className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  )
}
