'use client'

import { Button } from '@/components/ui/button'
import Image from 'next/image'
import logo from './logo-transparent.png'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
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
        <p className="text-xl text-muted-foreground mb-4">
          Error: {error.message}
        </p>
      </div>
      <Button onClick={() => reset()}>
        Try again
      </Button>
    </div>
  )
}
