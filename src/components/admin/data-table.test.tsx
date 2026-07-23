import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DataTable } from "./data-table";

afterEach(cleanup);

const columns = [
  { key: "name", label: "Name" },
  { key: "status", label: "Status" },
] as const;

describe("admin data table", () => {
  it("renders a responsive ledger with accessible column labels", () => {
    render(
      <DataTable
        ariaLabel="Users"
        basePath="/admin/users"
        columns={columns}
        rows={[
          {
            id: "user-1",
            cells: {
              name: "Ama Mensah",
              status: "Active",
            },
          },
        ]}
        currentCursor={null}
        previousCursors={[]}
        nextCursor=""
        isDone
      />,
    );

    const table = screen.getByRole("table", { name: "Users" });
    expect(within(table).getByRole("columnheader", { name: "Name" })).toBeVisible();
    expect(within(table).getByText("Ama Mensah").closest("td")).toHaveAttribute(
      "data-label",
      "Name",
    );
  });

  it("preserves exact filters through next and previous navigation", () => {
    render(
      <DataTable
        ariaLabel="Users"
        basePath="/admin/users"
        columns={columns}
        rows={[
          {
            id: "user-2",
            cells: { name: "Kojo Owusu", status: "Suspended" },
          },
        ]}
        filters={[
          {
            name: "by",
            label: "Lookup field",
            value: "email",
            options: [
              { value: "email", label: "Email address" },
              { value: "user_id", label: "User ID" },
            ],
          },
          {
            name: "q",
            label: "Exact value",
            value: "kojo@example.com",
            placeholder: "name@example.com",
          },
        ]}
        currentCursor="cursor-current"
        previousCursors={["~", "cursor-before"]}
        nextCursor="cursor-next"
        isDone={false}
      />,
    );

    expect(screen.getByLabelText("Lookup field")).toHaveValue("email");
    expect(screen.getByLabelText("Exact value")).toHaveValue(
      "kojo@example.com",
    );

    const next = screen.getByRole("link", { name: "Next page" });
    const previous = screen.getByRole("link", { name: "Previous page" });
    expect(next).toHaveAttribute(
      "href",
      expect.stringContaining("q=kojo%40example.com"),
    );
    expect(next).toHaveAttribute(
      "href",
      expect.stringContaining("cursor=cursor-next"),
    );
    expect(previous).toHaveAttribute(
      "href",
      expect.stringContaining("cursor=cursor-before"),
    );
  });

  it("renders explicit loading, empty, and recoverable error states", () => {
    const { rerender } = render(
      <DataTable
        ariaLabel="Conversations"
        basePath="/admin/conversations"
        columns={columns}
        rows={[]}
        currentCursor={null}
        previousCursors={[]}
        nextCursor=""
        isDone
        state="loading"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading conversation records",
    );

    rerender(
      <DataTable
        ariaLabel="Conversations"
        basePath="/admin/conversations"
        columns={columns}
        rows={[]}
        currentCursor={null}
        previousCursors={[]}
        nextCursor=""
        isDone
        emptyMessage="No conversations match this exact lookup."
      />,
    );
    expect(screen.getByText("No conversations match this exact lookup.")).toBeVisible();

    rerender(
      <DataTable
        ariaLabel="Conversations"
        basePath="/admin/conversations"
        columns={columns}
        rows={[]}
        currentCursor={null}
        previousCursors={[]}
        nextCursor=""
        isDone
        state="error"
        errorMessage="Conversation records could not be loaded. Check the filter and try again."
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Conversation records could not be loaded",
    );
    expect(screen.getByRole("link", { name: "Clear filters" })).toHaveAttribute(
      "href",
      "/admin/conversations",
    );
  });
});
