import type { Metadata } from "next";
import localFont from "next/font/local";
import { ConvexClientProvider } from "@/components/providers/convex-client-provider";
import { ImpersonationBanner } from "@/components/admin/impersonation-banner";
import { ThemeProvider } from "@/components/providers/theme-provider";
import "./globals.css";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "Law of the Land \u2014 Jurisdiction-specific legal information",
  description:
    "Ask legal questions in plain language and review jurisdiction-specific answers grounded in published legal sources and citations.",
  icons: { icon: "/favicon.ico" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `(function(){var t='system';try{t=localStorage.getItem('lotl-theme')||'system'}catch(e){}var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.add(d?'dark':'light')})()` }} />
      </head>
      <body className="flex min-h-screen flex-col antialiased">
        <ThemeProvider>
          <ConvexClientProvider>
            <ImpersonationBanner />
            <div className="flex min-h-0 flex-1 flex-col">{children}</div>
          </ConvexClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
