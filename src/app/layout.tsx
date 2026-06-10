import type { Metadata } from "next";
import Link from "next/link";
import localFont from "next/font/local";
import Image from "next/image";
import { AuthSessionBootstrap } from "@/components/auth/auth-session-bootstrap";
import { UserNav } from "@/components/auth/user-nav";
import { ConvexClientProvider } from "@/components/providers/convex-client-provider";
import { getToken } from "@/lib/auth-server";
import logo from "./logo-transparent.png";
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
  title: "Law of the Land",
  description: "Ask questions in plain language and get answers grounded in a legal document library.",
  icons: {
    icon: "/favicon.ico",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const token = await getToken();

  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="flex min-h-screen flex-col antialiased">
        <ConvexClientProvider initialToken={token}>
          <AuthSessionBootstrap />
          <nav className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
            <div className="container mx-auto flex h-16 items-center justify-between px-4">
              <Link href="/" className="flex items-center gap-2">
                <Image src={logo} alt="Law of the Land — home" width={80} priority />
              </Link>
              <div className="flex items-center gap-4">
                <Link
                  href="/pricing"
                  className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  Pricing
                </Link>
                <UserNav />
              </div>
            </div>
          </nav>
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
          <div className="border-t px-4 py-3 text-center text-xs text-muted-foreground">
            General information from public legal sources, not legal advice for your case. For decisions
            that affect your rights or obligations, talk to a qualified attorney.
          </div>
        </ConvexClientProvider>
      </body>
    </html>
  );
}
