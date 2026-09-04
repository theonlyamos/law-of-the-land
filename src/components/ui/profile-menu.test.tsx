import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { ProfileMenu } from "./profile-menu";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.documentElement.classList.remove("light", "dark"); });

it("opens above the profile and supports theme selection and Escape", async () => {
  render(<ThemeProvider><ProfileMenu name="Amos Amissah" onSignOut={vi.fn()} /></ThemeProvider>);
  expect(screen.queryByRole("link", { name: "Billing" })).not.toBeInTheDocument();
  const profile = screen.getByRole("button", { name: "Account options for Amos Amissah" });
  fireEvent.click(profile);
  expect(screen.getByRole("link", { name: "Billing" })).toHaveAttribute("href", "/settings/billing");
  fireEvent.click(screen.getByRole("button", { name: "Light" }));
  expect(document.documentElement).toHaveClass("light");
  expect(localStorage.getItem("lotl-theme")).toBe("light");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(profile).toHaveFocus();
});

it("restores a saved theme and reports sign-out failures", async () => {
  localStorage.setItem("lotl-theme", "light");
  render(<ThemeProvider><ProfileMenu name="Amos" onSignOut={vi.fn().mockRejectedValue(new Error("offline"))} /></ThemeProvider>);
  await waitFor(() => expect(document.documentElement).toHaveClass("light"));
  fireEvent.click(screen.getByRole("button", { name: "Account options for Amos" }));
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not sign out");
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("follows system changes only while System is selected", () => {
  const media = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.mocked(window.matchMedia).mockReturnValue(media as unknown as MediaQueryList);
  render(<ThemeProvider><ProfileMenu name="Amos" onSignOut={vi.fn()} /></ThemeProvider>);
  const changed = media.addEventListener.mock.calls[0][1] as () => void;
  expect(document.documentElement).toHaveClass("dark");
  media.matches = false;
  act(changed);
  expect(document.documentElement).toHaveClass("light");
  fireEvent.click(screen.getByRole("button", { name: "Account options for Amos" }));
  fireEvent.click(screen.getByRole("button", { name: "Dark" }));
  act(changed);
  expect(document.documentElement).toHaveClass("dark");
  fireEvent.click(screen.getByRole("button", { name: "System" }));
  expect(document.documentElement).toHaveClass("light");
});
