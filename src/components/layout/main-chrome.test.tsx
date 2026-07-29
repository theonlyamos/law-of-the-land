import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MainLayout from "@/app/(main)/layout";

const mocks = vi.hoisted(() => ({
  pathname: "/",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
}));

vi.mock("@/components/auth/user-nav", () => ({
  UserNav: () => <span>Account controls</span>,
}));

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <span aria-label={alt} />,
}));

afterEach(cleanup);

describe("main route chrome", () => {
  it("leaves the landing route to render its own professional header", () => {
    mocks.pathname = "/";

    render(
      <MainLayout>
        <div>Landing content</div>
      </MainLayout>,
    );

    expect(screen.getByText("Landing content")).toBeVisible();
    expect(screen.queryByLabelText(/Law of the Land.*home/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/not legal advice/i)).not.toBeInTheDocument();
  });

  it("preserves the existing compact chrome on settings routes", () => {
    mocks.pathname = "/settings/billing";

    render(
      <MainLayout>
        <div>Settings content</div>
      </MainLayout>,
    );

    expect(screen.getByText("Settings content")).toBeVisible();
    expect(screen.getByLabelText(/Law of the Land.*home/i)).toBeVisible();
    expect(screen.getByText(/not legal advice/i)).toBeVisible();
  });
});
