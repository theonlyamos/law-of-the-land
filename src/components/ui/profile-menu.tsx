"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CreditCard, LogOut, Monitor, Moon, Settings, Sun } from "lucide-react";
import Link from "next/link";
import { useTheme } from "@/components/providers/theme-provider";
import { Button } from "./button";

export function ProfileMenu({ name, image, collapsed = false, onNavigate, onSignOut }: {
  name: string;
  image?: string | null;
  collapsed?: boolean;
  onNavigate?: () => void;
  onSignOut: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState(false);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLAnchorElement>("a")?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);

  function navigate() { setOpen(false); onNavigate?.(); }
  async function signOut() {
    setError(false);
    setSigningOut(true);
    try { await onSignOut(); setOpen(false); }
    catch { setError(true); }
    finally { setSigningOut(false); }
  }

  return (
    <div ref={root} className="relative" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
    }}>
      {open && (
        <div ref={panel} id={panelId} role="dialog" aria-label="Account options"
          className="absolute bottom-full left-0 z-50 mb-2 w-60 max-w-[calc(100vw-1.5rem)] rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-xl">
          <Button asChild variant="ghost" className="h-10 w-full justify-start gap-3 px-3">
            <Link href="/settings/billing" onClick={navigate}><CreditCard className="size-4 text-muted-foreground" />Billing</Link>
          </Button>
          <Button asChild variant="ghost" className="h-10 w-full justify-start gap-3 px-3">
            <Link href="/settings/security" onClick={navigate}><Settings className="size-4 text-muted-foreground" />Settings</Link>
          </Button>
          <div className="mx-1 my-1.5 border-t" />
          <div className="px-3 py-2">
            <p className="mb-2 text-xs text-muted-foreground" id={`${panelId}-theme`}>Appearance</p>
            <div role="group" aria-labelledby={`${panelId}-theme`} className="flex gap-0.5 rounded-lg border bg-muted/50 p-0.5">
              {([{ value: "light", label: "Light", Icon: Sun }, { value: "dark", label: "Dark", Icon: Moon }, { value: "system", label: "System", Icon: Monitor }] as const).map(({ value, label, Icon }) => (
                <button key={value} type="button" aria-pressed={theme === value} onClick={() => setTheme(value)}
                  className={`flex min-h-9 min-w-0 flex-1 items-center justify-center gap-1 rounded-md text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${theme === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
                  <Icon className="size-3.5 shrink-0" aria-hidden="true" />{label}
                </button>
              ))}
            </div>
          </div>
          <div className="mx-1 my-1.5 border-t" />
          <Button variant="ghost" disabled={signingOut} onClick={() => void signOut()}
            className="h-10 w-full justify-start gap-3 px-3 text-red-700 hover:bg-red-700/10 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-400/10 dark:hover:text-red-400">
            <LogOut className="size-4" />{signingOut ? "Signing out…" : "Sign out"}
          </Button>
          {error && <p role="alert" className="px-3 py-2 text-xs text-destructive">Could not sign out. Try again.</p>}
        </div>
      )}
      <Button ref={trigger} variant="ghost" aria-expanded={open} aria-controls={panelId} aria-haspopup="dialog"
        aria-label={`Account options for ${name}`} onClick={() => setOpen(value => !value)}
        className={`h-auto min-h-12 w-full justify-start gap-2 rounded-lg px-2 py-2 ${open ? "bg-accent" : ""} ${collapsed ? "md:justify-center md:px-0" : ""}`}>
        <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-secondary text-xs font-semibold text-secondary-foreground" aria-hidden="true">
          {image && failedImage !== image
            // User avatar URLs can originate from external identity providers.
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={image} alt="" className="size-full object-cover" onError={() => setFailedImage(image)} />
            : name.charAt(0).toUpperCase()}
        </span>
        <span className={`min-w-0 flex-1 truncate text-left text-sm ${collapsed ? "md:hidden" : ""}`}>{name}</span>
      </Button>
    </div>
  );
}
