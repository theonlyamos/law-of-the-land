import Link from 'next/link'
import { Button } from '@/components/ui/button'
import Image from 'next/image'
import logo from './logo-transparent.png'

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-6 px-4">
      <Image
        src={logo}
        alt="Law of the Land Logo"
        width={80}
        priority
      />
      <div className="text-center">
        <h1 className="text-4xl font-bold mb-4">Page not found</h1>
        <p className="text-xl text-muted-foreground mb-8">
          Oops! The page you're looking for doesn't exist.
        </p>
      </div>
      <Button variant="default" asChild>
        <Link href="/">
          Go back home
        </Link>
      </Button>
    </div>
  )
}
