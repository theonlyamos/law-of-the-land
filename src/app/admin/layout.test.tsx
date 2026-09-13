import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const mocks = vi.hoisted(() => ({
  auth: { isLoading: true, isAuthenticated: false },
  pathname: "/admin/review",
  search: "",
  authorize: vi.fn(),
  query: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => mocks.auth,
  usePaginatedQuery: mocks.query,
  useQuery: mocks.query,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-admin-pathname": mocks.pathname }) }));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname, useSearchParams: () => new URLSearchParams(mocks.search), redirect: mocks.redirect }));
vi.mock("@/lib/admin/server", () => ({ authorizeAdminPage: mocks.authorize }));
vi.mock("@/components/providers/account-providers", () => ({ AccountProviders: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/admin/admin-shell", () => ({ AdminShell: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/admin/document-review", () => ({ DocumentReview: () => null }));

import AdminLayout from "./layout";
import { ReviewDocket } from "@/components/admin/review-docket";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth = { isLoading: true, isAuthenticated: false };
  mocks.pathname = "/admin/review";
  mocks.search = "";
  mocks.authorize.mockResolvedValue({ status: "authorized", currentAdmin: { userId: "admin", roles: ["super_admin"] } });
  mocks.query.mockReturnValue({ results: [], status: "Exhausted", loadMore: vi.fn() });
  mocks.redirect.mockImplementation(() => { throw new Error("NEXT_REDIRECT"); });
});
afterEach(cleanup);

it("waits for Convex authentication before mounting review subscriptions and stops them on session loss", async () => {
  const content = () => AdminLayout({ children: <ReviewDocket /> });
  const { rerender } = render(await content());
  expect(mocks.query.mock.calls.length).toBe(0);
  expect(screen.getByRole("status")).toHaveTextContent("Verifying your session");

  mocks.auth = { isLoading: false, isAuthenticated: true };
  rerender(await content());
  expect(mocks.query).toHaveBeenCalled();
  expect(screen.getByRole("group", { name: "Filter by document status" })).toBeVisible();

  mocks.query.mockClear();
  mocks.auth = { isLoading: false, isAuthenticated: false };
  rerender(await content());
  expect(mocks.query).not.toHaveBeenCalled();
  expect(screen.queryByRole("group", { name: "Filter by document status" })).toBeNull();
  expect(screen.getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", "/signin?redirect=%2Fadmin%2Freview");
});

it("preserves filters and pagination when recovering a lost session", async () => {
  mocks.auth = { isLoading: false, isAuthenticated: false };
  mocks.pathname = "/admin/users";
  mocks.search = "by=email&q=reader%40example.com&cursor=current&history=first&history=second";
  render(await AdminLayout({ children: <p>Protected records</p> }));
  const href = screen.getByRole("link", { name: "Sign in again" }).getAttribute("href")!;
  expect(new URL(href, "https://app.example").searchParams.get("redirect"))
    .toBe(`/admin/users?${mocks.search}`);
});

it("keeps the forbidden page accessible without browser authentication", async () => {
  mocks.pathname = "/admin/forbidden";
  render(await AdminLayout({ children: <p>Access denied</p> }));
  expect(screen.getByText("Access denied")).toBeVisible();
  expect(mocks.authorize).not.toHaveBeenCalled();
});

it("retains server-side admin authorization before rendering protected content", async () => {
  mocks.authorize.mockResolvedValue({ status: "denied" });
  await expect(AdminLayout({ children: <ReviewDocket /> })).rejects.toThrow("NEXT_REDIRECT");
  expect(mocks.redirect).toHaveBeenCalledWith("/admin/forbidden");
  expect(mocks.query).not.toHaveBeenCalled();
});
