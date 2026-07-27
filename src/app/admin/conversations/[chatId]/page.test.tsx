import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeAdminPage: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/lib/admin/server", () => ({
  authorizeAdminPage: mocks.authorizeAdminPage,
}));
vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
}));
vi.mock("@/components/admin/conversation-viewer", () => ({
  ConversationViewer: () => <section aria-label="Protected conversation viewer" />,
}));

import ConversationDetailPage from "./page";

beforeEach(() => {
  mocks.authorizeAdminPage.mockReset();
  mocks.redirect.mockReset();
  mocks.redirect.mockImplementation(() => {
    throw new Error("NEXT_REDIRECT");
  });
  mocks.authorizeAdminPage.mockResolvedValue({
    status: "authorized",
    currentAdmin: { userId: "support_1", roles: ["support_agent"] },
  });
});

afterEach(cleanup);

describe("conversation detail page", () => {
  it("renders a protected transcript gate without preloading message content", async () => {
    render(
      await ConversationDetailPage({
        params: Promise.resolve({ chatId: "chat_42" }),
      }),
    );

    expect(screen.getByRole("heading", { name: "Conversation record" })).toBeVisible();
    expect(screen.getByText("chat_42")).toBeVisible();
    expect(screen.getByRole("link", { name: "Back to conversations" })).toHaveAttribute(
      "href",
      "/admin/conversations",
    );
  });

  it("redirects roles without conversation-content permission", async () => {
    mocks.authorizeAdminPage.mockResolvedValue({
      status: "authorized",
      currentAdmin: { userId: "auditor_1", roles: ["auditor"] },
    });

    await expect(
      ConversationDetailPage({
        params: Promise.resolve({ chatId: "chat_42" }),
      }),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.redirect).toHaveBeenCalledWith("/admin/forbidden");
  });
});
