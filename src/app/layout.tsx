import type { Metadata } from "next";
import localFont from "next/font/local";
import { AuthSessionBootstrap } from "@/components/auth/auth-session-bootstrap";
import { ConvexClientProvider } from "@/components/providers/convex-client-provider";
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="flex min-h-screen flex-col antialiased">
        <ConvexClientProvider>
          <AuthSessionBootstrap />
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        </ConvexClientProvider>
      </body>
    </html>
  );
}
