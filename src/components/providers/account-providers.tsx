import { ConvexClientProvider } from "./convex-client-provider";
import { ImpersonationBanner } from "@/components/admin/impersonation-banner";
import { ThemeProvider } from "./theme-provider";

export function AccountProviders({ children }: { children: React.ReactNode }) {
  return <ThemeProvider><ConvexClientProvider><ImpersonationBanner /><div className="flex min-h-0 flex-1 flex-col">{children}</div></ConvexClientProvider></ThemeProvider>;
}
