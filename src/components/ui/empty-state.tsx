import { cn } from "@/lib/utils"
import { Button, ButtonProps } from "@/components/ui/button"
import { ReactNode } from "react"

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick?: () => void;
    href?: string;
  };
  className?: string;
  variant?: 'default' | 'muted';
}

function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  variant = 'default',
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center p-8 text-center",
        variant === 'muted' && "rounded-lg border border-dashed p-12",
        className
      )}
    >
      {icon && (
        <div className="mb-4 text-muted-foreground">
          {icon}
        </div>
      )}
      <h3 className="text-lg font-semibold">{title}</h3>
      {description && (
        <p className="mt-2 text-sm text-muted-foreground max-w-md">
          {description}
        </p>
      )}
      {action && (
        <div className="mt-6">
          {action.href ? (
            <Button asChild>
              <a href={action.href}>{action.label}</a>
            </Button>
          ) : (
            <Button onClick={action.onClick}>{action.label}</Button>
          )}
        </div>
      )}
    </div>
  )
}

// Pre-configured empty state variants
function NoResultsEmptyState({ query, onClear }: { query?: string; onClear?: () => void }) {
  return (
    <EmptyState
      icon={<Search className="h-12 w-12" />}
      title="No results found"
      description={
        query
          ? `No results found for "${query}". Try a different search term.`
          : "No results found. Try adjusting your search."
      }
      action={onClear ? { label: "Clear search", onClick: onClear } : undefined}
    />
  )
}

function NoDataEmptyState({ 
  title = "No data yet", 
  description = "Get started by adding your first item.", 
  action 
}: { 
  title?: string; 
  description?: string; 
  action?: EmptyStateProps['action'] 
}) {
  return (
    <EmptyState
      icon={<FileText className="h-12 w-12" />}
      title={title}
      description={description}
      action={action}
      variant="muted"
    />
  )
}

function ChatEmptyState({ onAction }: { onAction?: (question: string) => void }) {
  const suggestions = [
    "What are my rights as a tenant?",
    "Can I get a refund for defective products?",
    "What should I do if I get a speeding ticket?",
  ]

  return (
    <EmptyState
      icon={<MessageSquare className="h-12 w-12" />}
      title="Start a conversation"
      description="Ask a question about your legal rights or local laws to get started."
      action={
        onAction
          ? { label: "View suggested questions", onClick: () => onAction(suggestions[0]) }
          : undefined
      }
    />
  )
}

import { Search, FileText, MessageSquare } from "lucide-react"

export {
  EmptyState,
  NoResultsEmptyState,
  NoDataEmptyState,
  ChatEmptyState,
}
