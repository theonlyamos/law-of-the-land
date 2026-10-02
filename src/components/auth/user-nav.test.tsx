import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UserNav } from "./user-nav";

const mocks = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname, useRouter: () => ({}) }));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: false, isLoading: false }),
  useQuery: () => null,
}));
vi.mock("@/lib/auth-client", () => ({ authClient: {} }));
afterEach(cleanup);

it.each([
  ["/research", "/signin?redirect=%2Fresearch"],
  ["/", "/signin"],
])("preserves guest research through header sign-in on %s", (pathname, href) => {
  mocks.pathname = pathname;
  render(<UserNav />);
  expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", href);
});
