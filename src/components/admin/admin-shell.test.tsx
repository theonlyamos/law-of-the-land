import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminShell } from "./admin-shell";
import { AdminNav } from "./admin-nav";
import {
  AdminPermissionProvider,
  PermissionBoundary,
} from "./permission-boundary";

const navigation = vi.hoisted(() => ({ pathname: "/admin" }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
}));

afterEach(cleanup);

describe("administration shell permissions", () => {
  it("shows support tools without exposing document administration", () => {
    render(<AdminNav roles={["support_agent"]} />);

    expect(screen.getByRole("link", { name: "Users" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Conversations" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Documents" })).toBeNull();
  });

  it("renders the fallback when a role lacks the requested permission", () => {
    render(
      <AdminPermissionProvider permissions={["user:read"]}>
        <PermissionBoundary
          resource="document"
          action="read"
          fallback={<p>Document access required</p>}
        >
          <p>Document controls</p>
        </PermissionBoundary>
      </AdminPermissionProvider>,
    );

    expect(screen.getByText("Document access required")).toBeVisible();
    expect(screen.queryByText("Document controls")).toBeNull();
  });

  it("provides a keyboard skip link and a named administration region", () => {
    render(
      <AdminShell
        currentAdmin={{ userId: "admin_1", roles: ["auditor"] }}
        currentPath="/admin"
      >
        <h1>System overview</h1>
      </AdminShell>,
    );

    expect(screen.getByRole("link", { name: "Skip to administration content" })).toHaveAttribute(
      "href",
      "#admin-main-content",
    );
    expect(screen.getByRole("main")).toHaveAttribute("id", "admin-main-content");
    expect(screen.getByRole("navigation", { name: "Administration" })).toBeVisible();
  });

  it("keeps intermediate-width administration navigation in the page flow", () => {
    render(
      <AdminShell
        currentAdmin={{ userId: "admin_1", roles: ["super_admin"] }}
        currentPath="/admin"
      >
        <h1>System overview</h1>
      </AdminShell>,
    );

    expect(screen.getByRole("navigation", { name: "Administration" })).toHaveClass(
      "md:block",
    );
    expect(screen.getByRole("main").parentElement).toHaveClass(
      "md:grid-cols-[14rem_minmax(0,1fr)]",
    );
  });

  it("uses the public brand logo in the administration header", () => {
    render(
      <AdminShell currentAdmin={{ userId: "admin_1", roles: ["auditor"] }}>
        <h1>Audit</h1>
      </AdminShell>,
    );

    expect(screen.getByRole("img", { name: "Law of the Land" })).toBeVisible();
  });

  it("uses a menu control instead of the public-site link before the medium breakpoint", () => {
    render(
      <AdminShell currentAdmin={{ userId: "admin_1", roles: ["auditor"] }}>
        <h1>Audit</h1>
      </AdminShell>,
    );

    expect(screen.getByRole("banner").firstElementChild).toHaveClass(
      "grid-cols-[minmax(0,1fr)_auto]",
    );
    expect(
      screen
        .getAllByRole("link", { name: "Return to public site" })
        .some((link) => link.classList.contains("hidden")),
    ).toBe(true);

    const menu = screen.getByRole("button", { name: "Open administration menu" });
    expect(menu).toHaveAttribute("aria-controls", "admin-sidebar");
    expect(menu).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(menu);

    expect(screen.getByRole("button", { name: "Close administration menu" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("complementary")).toHaveClass("fixed");
    expect(screen.getByRole("complementary")).not.toHaveClass("hidden");
  });

  it("updates the active navigation item after client-side navigation", () => {
    navigation.pathname = "/admin/sessions";
    render(<AdminNav roles={["super_admin"]} />);

    expect(screen.getByRole("link", { name: "Sessions" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Users" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("collapses the tablet-and-desktop sidebar from the header", () => {
    render(
      <AdminShell currentAdmin={{ userId: "admin_1", roles: ["auditor"] }}>
        <h1>Audit</h1>
      </AdminShell>,
    );

    const toggle = screen.getByRole("button", {
      name: "Collapse administration navigation",
    });
    expect(screen.getByRole("banner")).toContainElement(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(toggle);

    expect(
      screen.getByRole("button", { name: "Expand administration navigation" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("complementary")).toHaveClass(
      "md:hidden",
    );
    expect(screen.getByRole("main").parentElement).toHaveClass("md:grid-cols-1");
  });
});
