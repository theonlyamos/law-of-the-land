import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AdminShell } from "./admin-shell";
import { AdminNav } from "./admin-nav";
import {
  AdminPermissionProvider,
  PermissionBoundary,
} from "./permission-boundary";

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
});
