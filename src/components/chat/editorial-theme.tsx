import localFont from "next/font/local";
import { cn } from "@/lib/utils";
import "./editorial-theme.css";

const chatSans = localFont({
  src: "../../app/fonts/DMSans-Latin.woff2",
  variable: "--font-chat-sans",
  weight: "400 700",
  display: "swap",
});
const chatSerif = localFont({
  src: [
    { path: "../../app/fonts/InstrumentSerif-Latin.woff2", weight: "400", style: "normal" },
    { path: "../../app/fonts/InstrumentSerif-Italic-Latin.woff2", weight: "400", style: "italic" },
  ],
  variable: "--font-chat-serif",
  display: "swap",
});

export function EditorialTheme({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("chat-editorial", chatSans.variable, chatSerif.variable, className)}>{children}</div>;
}
