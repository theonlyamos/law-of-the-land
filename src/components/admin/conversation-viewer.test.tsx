import { AdminPermissionProvider } from "./permission-boundary";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const convex = vi.hoisted(() => ({
  createGrant: vi.fn(),
  queueExport: vi.fn(),
  queryArgs: undefined as unknown,
  queryOptions: undefined as unknown,
  loadMore: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useMutation: () => (args: Record<string, unknown>) =>
    "purpose" in args
      ? convex.createGrant(args)
      : convex.queueExport(args),
  usePaginatedQuery: (_reference: unknown, args: unknown, options: unknown) => {
    convex.queryArgs = args;
    convex.queryOptions = options;
    if (args === "skip") {
      return { results: [], status: "LoadingFirstPage", loadMore: convex.loadMore };
    }
    return {
      results: [
        {
          id: "message_1",
          role: "assistant",
          content:
            "## Finding\n<script>alert('unsafe')</script>\n![tracker](https://tracking.example/pixel.png)\n[safe](https://example.com/case) [mail](mailto:support@example.com) [bad](javascript:alert(1))\npassword: [REDACTED]",
          createdAt: 1_900_000_000_000,
        },
      ],
      status: "CanLoadMore",
      loadMore: convex.loadMore,
    };
  },
}));

import { ConversationViewer } from "./conversation-viewer";

beforeEach(() => {
  convex.createGrant.mockReset();
  convex.queueExport.mockReset();
  convex.loadMore.mockReset();
  convex.queryArgs = undefined;
  convex.queryOptions = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true }),
  );
  convex.createGrant.mockResolvedValue({
    grantId: "grant_42",
    expiresAt: 1_900_000_900_000,
  });
  convex.queueExport.mockResolvedValue({
    status: "queued",
    correlationId: "op_export42",
    action: "conversation_export",
    targetId: "chat_42",
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderViewer(permissions = ["conversation:read_content", "conversation:export"]) {
  return render(
    <AdminPermissionProvider permissions={permissions}>
      <ConversationViewer chatId={"chat_42" as never} />
    </AdminPermissionProvider>,
  );
}

describe("conversation viewer", () => {
  it("does not query messages until the administrator submits a purpose", async () => {
    renderViewer();

    expect(convex.queryArgs).toBe("skip");
    expect(convex.queryOptions).toEqual({ initialNumItems: 50 });
    expect(screen.queryByRole("heading", { name: "Finding" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Purpose for access"), {
      target: { value: "Ticket 42 investigation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));

    await waitFor(() =>
      expect(convex.createGrant).toHaveBeenCalledWith({
        chatId: "chat_42",
        purpose: "Ticket 42 investigation",
      }),
    );
    await waitFor(() =>
      expect(convex.queryArgs).toEqual({
        chatId: "chat_42",
        grantId: "grant_42",
      }),
    );
    expect(screen.getByRole("heading", { name: "Finding" })).toBeVisible();
    expect(screen.getByText("password: [REDACTED]")).toBeVisible();
  });

  it("sanitizes raw HTML and unsafe Markdown links", async () => {
    renderViewer();
    fireEvent.change(screen.getByLabelText("Purpose for access"), {
      target: { value: "Ticket 42 investigation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));

    await screen.findByRole("heading", { name: "Finding" });
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.queryByText("alert('unsafe')")).toBeNull();
    expect(screen.getByRole("link", { name: "safe" })).toHaveAttribute(
      "href",
      "https://example.com/case",
    );
    expect(screen.getByRole("link", { name: "safe" })).toHaveAttribute(
      "rel",
      expect.stringContaining("noopener"),
    );
    expect(screen.getByRole("link", { name: "mail" })).toHaveAttribute(
      "href",
      "mailto:support@example.com",
    );
    expect(screen.getByText("bad").closest("a")).toBeNull();
  });

  it("loads the next bounded page in batches of 50", async () => {
    renderViewer();
    fireEvent.change(screen.getByLabelText("Purpose for access"), {
      target: { value: "Ticket 42 investigation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));

    await screen.findByRole("button", { name: "Load 50 more messages" });
    fireEvent.click(screen.getByRole("button", { name: "Load 50 more messages" }));
    expect(convex.loadMore).toHaveBeenCalledWith(50);
  });

  it("queues export only after the exact phrase is typed", async () => {
    renderViewer();
    fireEvent.change(screen.getByLabelText("Purpose for access"), {
      target: { value: "Ticket 42 investigation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));
    await screen.findByRole("heading", { name: "Finding" });
    fireEvent.click(screen.getByRole("button", { name: "Prepare export" }));
    fireEvent.change(screen.getByLabelText("Reason for export"), {
      target: { value: "Attach transcript to ticket 42" },
    });
    fireEvent.change(screen.getByLabelText("Exact export confirmation"), {
      target: { value: "EXPORT chat_42" },
    });
    fireEvent.change(screen.getByLabelText("Confirm your password"), {
      target: { value: "private-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Queue conversation export" }));

    await waitFor(() => expect(convex.queueExport).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith(
      "/api/auth/verify-password",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-admin-step-up-action": "conversation_export",
          "x-admin-step-up-target": "chat_42:grant_42",
          "x-admin-step-up-key": expect.stringMatching(/^export_/),
        }),
        body: JSON.stringify({ password: "private-password" }),
      }),
    );
    expect(JSON.stringify(convex.queueExport.mock.calls)).not.toContain(
      "private-password",
    );
    expect(convex.queueExport).toHaveBeenCalledWith({
      chatId: "chat_42",
      grantId: "grant_42",
      reason: "Attach transcript to ticket 42",
      idempotencyKey: expect.stringMatching(/^export_/),
      confirmation: "EXPORT chat_42",
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Export queued",
    );
  });

  it("omits export controls without export permission", async () => {
    renderViewer(["conversation:read_content"]);
    fireEvent.change(screen.getByLabelText("Purpose for access"), {
      target: { value: "Ticket 42 investigation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));

    await screen.findByRole("heading", { name: "Finding" });
    expect(screen.queryByRole("button", { name: "Prepare export" })).toBeNull();
  });
});
