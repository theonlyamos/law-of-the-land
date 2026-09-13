import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchAuthQuery: vi.fn() }));
vi.mock("@/lib/admin/server", () => ({
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
    mocks.fetchAuthQuery.mockResolvedValue({
      page: [{
        id: "chat_42", userId: "reader_42", externalId: "browser_42",
        userName, userEmail, messageCount: 4,
        firstUserMessagePreview,
        createdAt: Date.UTC(2026, 8, 4, 21, 47),
        updatedAt: Date.UTC(2026, 8, 5, 10),
        jurisdiction: { id: "gh", name: "Ghana", kind: "geographic" },
      }],
      isDone: true, continueCursor: "",
    });
    render(await ConversationsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole("link", { name: conversationLabel! })).toHaveAttribute("href", "/admin/conversations/chat_42");
    expect(screen.getByText(/Sep 4, 2026/)).toBeVisible();
    expect(screen.getByRole("link", { name: label! })).toHaveAttribute("href", "/admin/users/reader_42");
    expect(screen.queryByText("chat_42")).toBeNull();
    expect(screen.queryByText("reader_42")).toBeNull();
  });
});
