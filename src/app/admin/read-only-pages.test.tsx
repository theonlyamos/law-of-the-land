import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../convex/_generated/api";

const mocks = vi.hoisted(() => ({
  authorizeAdminPage: vi.fn(),
  fetchAuthQuery: vi.fn(),
  isAdminAccessDenial: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/lib/admin/server", () => ({
  authorizeAdminPage: mocks.authorizeAdminPage,
  isAdminAccessDenial: mocks.isAdminAccessDenial,
}));
vi.mock("@/lib/auth-server", () => ({
  fetchAuthQuery: mocks.fetchAuthQuery,
}));
vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
}));
vi.mock("@/components/admin/user-actions", () => ({
  UserActions: () => <section aria-label="User actions" />,
}));

import ConversationsPage from "./conversations/page";
import OperationsPage from "./operations/page";
import UserDetailPage from "./users/[userId]/page";
import UsersPage from "./users/page";

afterEach(cleanup);

beforeEach(() => {
  mocks.authorizeAdminPage.mockReset();
  mocks.fetchAuthQuery.mockReset();
  mocks.isAdminAccessDenial.mockReset();
  mocks.redirect.mockReset();
  mocks.authorizeAdminPage.mockResolvedValue({
    status: "authorized",
    currentAdmin: { userId: "admin-1", roles: ["super_admin"] },
  });
  mocks.isAdminAccessDenial.mockImplementation(
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "data" in error &&
      typeof error.data === "object" &&
      error.data !== null &&
      "code" in error.data &&
      typeof error.data.code === "string" &&
      error.data.code.startsWith("ADMIN_"),
  );
  mocks.redirect.mockImplementation(() => {
    throw new Error("NEXT_REDIRECT");
  });
});

describe("read-only admin pages", () => {
  it("drives exact user lookup and cursor state from the URL", async () => {
    mocks.fetchAuthQuery.mockResolvedValue({
      page: [
        {
          id: "user-1",
          name: "Ama Mensah",
          email: "ama@example.com",
          emailVerified: true,
          createdAt: 1_900_000_000_000,
          updatedAt: 1_900_000_000_100,
          roles: ["support_agent"],
          banned: false,
          twoFactorEnabled: true,
        },
      ],
      isDone: false,
      continueCursor: "next-users",
    });

    render(
      await UsersPage({
        searchParams: Promise.resolve({
          by: "email",
          q: "ama@example.com",
          cursor: "current-users",
          history: ["~"],
        }),
      }),
    );

    expect(mocks.fetchAuthQuery).toHaveBeenCalledWith(api.admin.users.list, {
      paginationOpts: { numItems: 30, cursor: "current-users" },
      search: { kind: "email", value: "ama@example.com" },
    });
    expect(screen.getByRole("heading", { name: "Users" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Ama Mensah" })).toHaveAttribute(
      "href",
      "/admin/users/user-1",
    );
    expect(screen.getByRole("link", { name: "Ama Mensah" })).toHaveClass(
      "inline-flex",
      "min-h-11",
      "items-center",
    );
    expect(screen.getByRole("link", { name: "Next page" })).toHaveAttribute(
      "href",
      expect.stringContaining("q=ama%40example.com"),
    );
  });

  it("renders conversation metadata without content columns", async () => {
    mocks.fetchAuthQuery.mockResolvedValue({
      page: [
        {
          id: "conversation-1",
          userId: "user-1",
          externalId: "browser-session-1",
          messageCount: 4,
          updatedAt: 1_900_000_000_000,
          country: "GH",
        },
      ],
      isDone: true,
      continueCursor: "",
    });

    render(
      await ConversationsPage({
        searchParams: Promise.resolve({ userId: "user-1" }),
      }),
    );

    expect(mocks.fetchAuthQuery).toHaveBeenCalledWith(
      api.admin.conversations.list,
      {
        paginationOpts: { numItems: 30, cursor: null },
        userId: "user-1",
      },
    );
    expect(screen.getByRole("columnheader", { name: "Messages" })).toBeVisible();
    expect(
      screen.getByRole("link", { name: "conversation-1" }),
    ).toHaveAttribute("href", "/admin/conversations/conversation-1");
    expect(screen.getByRole("link", { name: "user-1" })).toHaveClass(
      "inline-flex",
      "min-h-11",
      "items-center",
    );
    expect(screen.queryByRole("columnheader", { name: "Prompt" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Answer" })).toBeNull();
  });

  it("adapts user detail session visibility to the current role", async () => {
    mocks.authorizeAdminPage.mockResolvedValue({
      status: "authorized",
      currentAdmin: { userId: "auditor-1", roles: ["auditor"] },
    });
    mocks.fetchAuthQuery.mockResolvedValue({
      page: [
        {
          id: "user-1",
          name: "Kojo Owusu",
          email: "kojo@example.com",
          emailVerified: true,
          createdAt: 1_900_000_000_000,
          updatedAt: 1_900_000_000_100,
          roles: [],
          banned: false,
          twoFactorEnabled: false,
        },
      ],
      isDone: true,
      continueCursor: "",
    });

    render(
      await UserDetailPage({
        params: Promise.resolve({ userId: "user-1" }),
        searchParams: Promise.resolve({}),
      }),
    );

    expect(mocks.fetchAuthQuery).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "Kojo Owusu" })).toBeVisible();
    expect(
      screen.getByText("Session records are not included in your role."),
    ).toBeVisible();
  });

  it("redirects a structured exact-user denial to the forbidden page", async () => {
    const denial = Object.assign(new Error("Administrative access denied"), {
      data: { code: "ADMIN_DISABLED", message: "Restricted" },
    });
    mocks.fetchAuthQuery.mockRejectedValue(denial);

    await expect(
      UserDetailPage({
        params: Promise.resolve({ userId: "user-1" }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.redirect).toHaveBeenCalledWith("/admin/forbidden");
    expect(mocks.isAdminAccessDenial).toHaveBeenCalledWith(denial);
  });

  it("renders a recoverable exact-user error for a generic outage", async () => {
    const outage = new Error("connection reset");
    mocks.fetchAuthQuery.mockRejectedValue(outage);

    render(
      await UserDetailPage({
        params: Promise.resolve({ userId: "user-1" }),
        searchParams: Promise.resolve({}),
      }),
    );

    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "User record could not be loaded",
    );
    expect(
      screen.getByRole("link", { name: "Try loading this user again" }),
    ).toHaveAttribute("href", "/admin/users/user-1");
  });

  it("renders bounded operational configuration posture", async () => {
    mocks.fetchAuthQuery.mockResolvedValue({
      page: [
        {
          id: "legal-search",
          label: "Legal search",
          configured: false,
          status: "configuration_required",
        },
      ],
      isDone: true,
      continueCursor: "integration-health:v1:5",
    });

    render(
      await OperationsPage({ searchParams: Promise.resolve({}) }),
    );

    expect(mocks.fetchAuthQuery).toHaveBeenCalledWith(
      api.admin.operations.listIntegrationHealth,
      { paginationOpts: { numItems: 20, cursor: null } },
    );
    expect(screen.getByText("Configuration required")).toBeVisible();
    expect(screen.queryByText("groundx-secret-value")).toBeNull();
    expect(screen.queryByText("polar-secret-value")).toBeNull();
  });
});
