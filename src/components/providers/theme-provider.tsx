"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

type Theme = "light" | "dark" | "system";
const STORAGE_KEY = "lotl-theme";
function validTheme(value: unknown): Theme {
  return value === "light" || value === "dark" ? value : "system";
}
function storedTheme(): Theme {
  try { return validTheme(localStorage.getItem(STORAGE_KEY)); } catch { return "system"; }
}
function applyTheme(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.classList.toggle("light", !dark);
}

const ThemeContext = createContext<{ theme: Theme; setTheme: (theme: Theme) => void }>({ theme: "system", setTheme: () => undefined });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, updateTheme] = useState<Theme>("system");
  const current = useRef<Theme>("system");
  const setTheme = useCallback((value: Theme) => {
    current.current = value;
    updateTheme(value);
    applyTheme(value);
    try { localStorage.setItem(STORAGE_KEY, value); } catch { /* Keep the in-memory selection when storage is unavailable. */ }
  }, []);

  useEffect(() => {
    const restore = () => {
      current.current = storedTheme();
      updateTheme(current.current);
      applyTheme(current.current);
    };
    restore();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const systemChanged = () => { if (current.current === "system") applyTheme("system"); };
    const storageChanged = (event: StorageEvent) => { if (event.key === STORAGE_KEY || event.key === null) restore(); };
    media.addEventListener("change", systemChanged);
    window.addEventListener("storage", storageChanged);
    return () => { media.removeEventListener("change", systemChanged); window.removeEventListener("storage", storageChanged); };
  }, []);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() { return useContext(ThemeContext); }
