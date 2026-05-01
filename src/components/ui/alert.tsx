import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { AlertCircle, CheckCircle, Info, AlertTriangle } from "lucide-react"
import { ReactNode } from "react"

const alertVariants = cva(
  "relative w-full rounded-lg border p-4 [&>svg~*]:pl-7 [&>svg+div]:translate-y-[-3px]",
  {
    variants: {
      variant: {
        default: "bg-background text-foreground border-border",
        destructive: "border-destructive/50 text-destructive dark:border-destructive [&>svg]:text-destructive",
        success: "border-green-500/50 text-green-700 dark:border-green-500 dark:text-green-400 [&>svg]:text-green-600 dark:[&>svg]:text-green-400",
        warning: "border-yellow-500/50 text-yellow-700 dark:border-yellow-500 dark:text-yellow-400 [&>svg]:text-yellow-600 dark:[&>svg]:text-yellow-400",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

interface AlertProps extends React.HTMLAttributes<HTMLDivElement>,
  VariantProps<typeof alertVariants> {
  icon?: ReactNode;
}

function Alert({
  className,
  variant,
  icon,
  children,
  ...props
}: AlertProps) {
  return (
    <div
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    >
      {icon && <div className="absolute left-4 top-4">{icon}</div>}
      {children}
    </div>
  )
}

function AlertTitle({ className, children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h5 className={cn("mb-1 font-medium leading-none tracking-tight", className)} {...props}>
      {children}
    </h5>
  )
}

function AlertDescription({ className, children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <div className={cn("text-sm [&_p]:leading-relaxed", className)} {...props}>
      {children}
    </div>
  )
}

// Pre-configured alert variants
function SuccessAlert({ title, children, ...props }: Omit<AlertProps, 'variant' | 'icon'> & { title?: string }) {
  return (
    <Alert variant="success" icon={<CheckCircle className="h-4 w-4" />} {...props}>
      {title && <AlertTitle>{title}</AlertTitle>}
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  )
}

function ErrorAlert({ title, children, ...props }: Omit<AlertProps, 'variant' | 'icon'> & { title?: string }) {
  return (
    <Alert variant="destructive" icon={<AlertCircle className="h-4 w-4" />} {...props}>
      {title && <AlertTitle>{title}</AlertTitle>}
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  )
}

function WarningAlert({ title, children, ...props }: Omit<AlertProps, 'variant' | 'icon'> & { title?: string }) {
  return (
    <Alert variant="warning" icon={<AlertTriangle className="h-4 w-4" />} {...props}>
      {title && <AlertTitle>{title}</AlertTitle>}
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  )
}

function InfoAlert({ title, children, ...props }: Omit<AlertProps, 'variant' | 'icon'> & { title?: string }) {
  return (
    <Alert variant="default" icon={<Info className="h-4 w-4" />} {...props}>
      {title && <AlertTitle>{title}</AlertTitle>}
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  )
}

export {
  Alert,
  AlertTitle,
  AlertDescription,
  SuccessAlert,
  ErrorAlert,
  WarningAlert,
  InfoAlert,
}
