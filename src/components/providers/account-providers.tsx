import { ConvexClientProvider } from "./convex-client-provider";
import { ImpersonationBanner } from "@/components/admin/impersonation-banner";
import { ThemeProvider } from "./theme-provider";

export function AccountProviders({ children }: { children: React.ReactNode }) {
  return <>
    <script dangerouslySetInnerHTML={{ __html: `(function(){var t='system';try{t=localStorage.getItem('lotl-theme')||'system'}catch(e){}var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.add(d?'dark':'light')})()` }} />
    <ThemeProvider><ConvexClientProvider><ImpersonationBanner /><div className="flex min-h-0 flex-1 flex-col">{children}</div></ConvexClientProvider></ThemeProvider>
  </>;
}
