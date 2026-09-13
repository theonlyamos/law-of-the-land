import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchAuthQuery: vi.fn() }));
vi.mock("@/lib/admin/server", () => ({
  isAdminAccessDenial: () => false,
  authorizeAdminPage: async () => ({
    status: "authorized",
    currentAdmin: { userId: "admin_1", roles: ["support_agent"] },
  }),
}));
vi.mock("@/lib/auth-server", () => ({ fetchAuthQuery: mocks.fetchAuthQuery }));

import ConversationsPage from "./page";

afterEach(cleanup);

describe("conversation register labels", () => {
  it.each([
    ["Case Reader", "reader@example.com", "Case Reader", "What are my rights as a tenant?", "What are my rights as a tenant?"],
    [" ", "reader@example.com", "reader@example.com", null, "No user message"],
    [null, null, "Unknown user", undefined, "Conversation"],
  ])("uses readable labels while preserving record links", async (userName, userEmail, label, firstUserMessagePreview, conversationLabel) => {
    mocks.fetchAuthQuery.mockReset().mockResolvedValueOnce({
      page: [{
        id: "chat_42", userId: "reader_42", externalId: "browser_42",
        userName, userEmail, messageCount: 4,
        createdAt: Date.UTC(2026, 8, 4, 21, 47),
        updatedAt: Date.UTC(2026, 8, 5, 10),
        jurisdiction: { id: "gh", name: "Ghana", kind: "geographic" },
      }],
      isDone: true, continueCursor: "",
    }).mockResolvedValueOnce([{ id: "chat_42", firstUserMessagePreview }]);
    render(await ConversationsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole("link", { name: conversationLabel! })).toHaveAttribute("href", "/admin/conversations/chat_42");
    expect(screen.getByText(/Sep 4, 2026/)).toBeVisible();
    expect(screen.getByRole("link", { name: label! })).toHaveAttribute("href", "/admin/users/reader_42");
    expect(screen.queryByText("chat_42")).toBeNull();
    expect(screen.queryByText("reader_42")).toBeNull();
  });

  it("fetches previews in batches of at most eight", async () => {
    const rows = Array.from({ length: 17 }, (_, index) => ({
      id: `chat_${index}`, userId: "reader", updatedAt: 1, messageCount: 1,
    }));
    mocks.fetchAuthQuery.mockReset().mockResolvedValueOnce({ page: rows, isDone: true, continueCursor: "" })
      .mockResolvedValue([]);
    await ConversationsPage({ searchParams: Promise.resolve({}) });
    expect(mocks.fetchAuthQuery.mock.calls.slice(1).map((call) => call[1].chatIds))
      .toEqual([rows.slice(0, 8).map((row) => row.id), rows.slice(8, 16).map((row) => row.id), ["chat_16"]]);
  });
});
