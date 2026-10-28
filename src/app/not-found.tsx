import Link from 'next/link'
import { LogoMark } from "@/components/brand/logo-mark";
import { Button } from '@/components/ui/button'

export default function NotFound() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-4 py-16">
      <LogoMark title="Law of the Land" className="h-20 w-20" />
      <div className="text-center">
        <h1 className="text-4xl font-bold mb-4">Page not found</h1>
        <p className="text-xl text-muted-foreground mb-8">
          That address is not valid, or the page was removed. Use the link below to return to the assistant.
        </p>
      </div>
      <Button variant="default" asChild>
        <Link href="/">
          Return to assistant
        </Link>
      </Button>
    </div>
  )
}
