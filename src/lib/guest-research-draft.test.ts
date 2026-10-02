import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearGuestResearchDraft, readGuestResearchDraft, saveGuestResearchDraft } from "./guest-research-draft";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

it("keeps a bounded draft across tabs and isolates the adopted conversation", () => {
  saveGuestResearchDraft("a".repeat(4_001));
  expect(readGuestResearchDraft()).toHaveLength(4_000);
  saveGuestResearchDraft(readGuestResearchDraft(), "claimed-chat");
  clearGuestResearchDraft();
  expect(readGuestResearchDraft()).toBe("");
  expect(readGuestResearchDraft("claimed-chat")).toHaveLength(4_000);
  expect(readGuestResearchDraft("other-chat")).toBe("");
});

it("discards expired or malformed drafts and tolerates blocked browser storage", () => {
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  saveGuestResearchDraft("Unsent question");
  vi.mocked(Date.now).mockReturnValue(now + 24 * 60 * 60 * 1_000);
  expect(readGuestResearchDraft()).toBe("");
  expect(localStorage.getItem("guest-research-draft")).toBeNull();
  localStorage.setItem("guest-research-draft", "not json");
  expect(readGuestResearchDraft()).toBe("");
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Blocked"); });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("Blocked"); });
  expect(() => saveGuestResearchDraft("Question")).not.toThrow();
  expect(readGuestResearchDraft()).toBe("");
  expect(() => clearGuestResearchDraft()).not.toThrow();
});
