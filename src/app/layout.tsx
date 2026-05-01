import type { Metadata } from "next";
import Link from "next/link";
import localFont from "next/font/local";
import Image from "next/image";
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
  description: "Easy access to legal information powered by AI",
  icons: {
    icon: '/favicon.ico',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="antialiased flex flex-col min-h-screen">
        <nav className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="container mx-auto flex items-center justify-between h-16 px-4">
            <Link href="/" className="flex items-center gap-2">
              <Image src={logo} alt="Law of the Land" width={80} priority />
            </Link>
            <div className="flex items-center gap-4">
              <Link href="/pricing" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
                Pricing
              </Link>
            </div>
          </div>
        </nav>
        <div className="flex-1">
          {children}
        </div>
        <div className="text-center text-xs text-muted-foreground py-3 px-4 border-t">
          This AI assistant provides general legal information, not legal advice. Consult a qualified attorney for specific legal matters.
        </div>
      </body>
    </html>
  );
}
