import { AdminPermissionProvider } from "./permission-boundary";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserActions } from "./user-actions";

const mutations = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useMutation: () => mutations.invoke,
}));

const user = {
  id: "user_42",
  name: "Case Reader",
  email: "reader@example.com",
  emailVerified: false,
  banned: false,
  roles: [] as string[],
};

function renderActions(permissions: string[]) {
  return render(
    <AdminPermissionProvider permissions={permissions}>
      <UserActions
        user={user}
        sessions={[{ id: "session_17", isImpersonated: false }]}
      />
    </AdminPermissionProvider>,
  );
}

beforeEach(() => {
  mutations.invoke.mockReset();
  mutations.invoke.mockResolvedValue({
    status: "succeeded",
    action: "test",
    targetId: user.id,
    correlationId: "op_test",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: true }),
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("administrative user actions", () => {
  it("renders only controls granted by the permission boundary", () => {
    renderActions(["user:support", "session:revoke"]);

    expect(
      screen.getByRole("button", { name: "Resend verification email" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Revoke session session_17" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Assign roles" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Impersonate user" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Queue user deletion" }),
    ).toBeNull();
  });

  it("uses a native accessible step-up dialog for role assignment", () => {
    renderActions(["user:set_role"]);

    fireEvent.click(screen.getByRole("button", { name: "Assign roles" }));

    expect(screen.getByRole("dialog")).toHaveAttribute(
      "aria-labelledby",
      "admin-step-up-title",
    );
    expect(
      screen.getByRole("textbox", { name: "Reason for this action" }),
    ).toBeVisible();
    expect(screen.getByLabelText("Confirm your password")).toHaveAttribute(
      "type",
      "password",
    );
    expect(screen.getByRole("button", { name: "Verify and assign roles" }))
      .toBeVisible();
  });

  it("verifies the credential without passing it to the Convex mutation", async () => {
    renderActions(["user:set_role"]);
    fireEvent.click(screen.getByRole("button", { name: "Assign roles" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Reason for this action" }),
      { target: { value: "Approved staffing change" } },
    );
    fireEvent.change(screen.getByLabelText("Confirm your password"), {
      target: { value: "private-password" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Verify and assign roles" }),
    );

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mutations.invoke).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(mutations.invoke.mock.calls)).not.toContain(
      "private-password",
    );
    expect(mutations.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: user.id,
        reason: "Approved staffing change",
        idempotencyKey: expect.any(String),
      }),
    );
  });

  it("states the exact confirmation before queueing deletion", () => {
    renderActions(["user:ban"]);
    fireEvent.click(
      screen.getByRole("button", { name: "Queue user deletion" }),
    );

    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "P" &&
          element.textContent === `Type DELETE ${user.id} to continue.`,
      ),
    ).toBeVisible();
    expect(screen.getByLabelText("Exact confirmation")).toBeVisible();
  });
});
