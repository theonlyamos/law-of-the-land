'use client' // Error components must be Client Components

import { useEffect } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import Image from 'next/image'
import logo from './logo-transparent.png'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Log the error to an error reporting service
    console.error(error)
  }, [error])

  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-6 px-4">
      <Image
        src={logo}
        alt="Law of the Land Logo"
        width={80}
        priority
      />
      <div className="text-center">
        <h1 className="text-4xl font-bold mb-4">Something went wrong!</h1>
        <p className="text-xl text-muted-foreground mb-8">
          We're sorry, but there was an internal error. Please try again.
        </p>
      </div>
      <div className="flex gap-4">
        <Button onClick={() => reset()}>
          Try again
        </Button>
        <Button variant="outline" asChild>
          <Link href="/">
            Go back home
          </Link>
        </Button>
      </div>
    </div>
  )
}
