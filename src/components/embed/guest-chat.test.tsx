import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GuestChat } from "./guest-chat";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("keeps design preview inert and independent of account storage", () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const storage = vi.spyOn(Storage.prototype, "getItem");
  render(<GuestChat preview config={{ publicId: "preview", jurisdictionName: "Greenfield", title: "Ask Greenfield", welcomeMessage: "Ask about policies", suggestedQuestions: ["How do I join?"], accent: "#8d6a35", side: "right", enabled: false, allowedOrigins: [] }} />);
  expect(screen.getByRole("textbox", { name: "Your question" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "How do I join?" })).toBeDisabled();
  expect(fetcher).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled(); storage.mockRestore();
});
