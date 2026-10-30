import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: { isAuthenticated: false, isLoading: false },
  user: undefined as unknown,
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => mocks.auth,
  useQuery: () => mocks.user,
  useMutation: (reference: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(reference);
    if (!mocks.mutations.has(name)) mocks.mutations.set(name, vi.fn().mockResolvedValue({ reference: "ABCD1234" }));
    return mocks.mutations.get(name);
  },
}));
import { SupportForm, supportErrorMessage } from "./support-form";

afterEach(() => {
  cleanup();
  mocks.mutations.clear();
  mocks.auth = { isAuthenticated: false, isLoading: false };
  mocks.user = undefined;
});

function fill(label: RegExp | string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("SupportForm", () => {
  it("lets a guest send a message with their email and shows the reference", async () => {
    render(<SupportForm fromPath="/research" initialCategory="bug" />);
    expect(screen.getByLabelText("What is this about?")).toHaveValue("bug");
    expect(screen.queryByText(/Attach an image/)).toBeNull();

    fill("Subject", "Citations do not open");
    fill("Message", "Clicking a citation does nothing on Safari.");
    fill("Email", "kofi@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Message sent"));
    expect(screen.getByText("#ABCD1234")).toBeVisible();
    expect(mocks.mutations.get("support:submitTicket")).toHaveBeenCalledWith(expect.objectContaining({
      category: "bug",
      subject: "Citations do not open",
      email: "kofi@example.com",
      pagePath: "/research",
    }));
    expect(screen.getByRole("link", { name: "Back to where I was" })).toHaveAttribute("href", "/research");
  });

  it("uses the account email for signed-in users and offers a screenshot", () => {
    mocks.auth = { isAuthenticated: true, isLoading: false };
    mocks.user = { email: "ama@example.com" };
    render(<SupportForm />);
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.getByText("ama@example.com")).toBeVisible();
    expect(screen.getByText(/Attach an image/)).toBeVisible();
  });

  it("shows the server's explanation when a message is refused", async () => {
    render(<SupportForm />);
    mocks.mutations.set("support:submitTicket", vi.fn().mockRejectedValue(new ConvexError({ code: "SUPPORT_RATE_LIMITED", message: "Please try again in about 5 minutes." })));
    fill("Subject", "Hello there");
    fill("Message", "A question about my account.");
    fill("Email", "kofi@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Please try again in about 5 minutes."));
  });

  it("falls back to a calm generic error", () => {
    expect(supportErrorMessage(new Error("network"))).toMatch(/couldn't send your message/);
  });
});
