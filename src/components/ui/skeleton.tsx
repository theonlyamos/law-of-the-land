import { cn } from "@/lib/utils"

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  )
}

// Pre-configured skeleton variants
function SkeletonText({ className, lines = 3 }: { className?: string; lines?: number }) {
  return (
    <div className={cn("space-y-2", className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className={`h-4 ${i === lines - 1 ? 'w-3/4' : 'w-full'}`}
        />
      ))}
    </div>
  )
}

function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={cn("space-y-3 rounded-xl border p-6", className)}>
      <Skeleton className="h-6 w-1/3" />
      <SkeletonText lines={3} />
    </div>
  )
}

function SkeletonAvatar({ className, showText = true }: { className?: string; showText?: boolean }) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <Skeleton className="h-10 w-10 rounded-full" />
      {showText && (
        <div className="space-y-2 flex-1">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      )}
    </div>
  )
}

function SkeletonMessage({ isUser }: { isUser?: boolean }) {
  return (
    <div className={`flex gap-3 ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && <SkeletonAvatar showText={false} />}
      <div className={`space-y-2 ${isUser ? 'max-w-[75%]' : 'max-w-[75%]'}`}>
        <Skeleton className="h-20 w-full rounded-lg" />
      </div>
      {isUser && <SkeletonAvatar showText={false} />}
    </div>
  )
}

export {
  Skeleton,
  SkeletonText,
  SkeletonCard,
  SkeletonAvatar,
  SkeletonMessage,
}
