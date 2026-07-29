import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
  useQuery: vi.fn(),
  auth: { isAuthenticated: false, isLoading: false },
  sessions: [] as Array<{
    id: string;
    title: string;
    lastMessage: string;
    timestamp: number;
    messageCount: number;
  }>,
  sessionsStatus: "Exhausted",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, push: mocks.push }),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => mocks.auth,
  usePaginatedQuery: () => ({ results: mocks.sessions, status: mocks.sessionsStatus }),
  useQuery: mocks.useQuery,
}));

import Home from "./page";

beforeEach(() => {
  mocks.replace.mockReset();
  mocks.push.mockReset();
  mocks.useQuery.mockReset();
  mocks.auth = { isAuthenticated: false, isLoading: false };
  mocks.sessions = [];
  mocks.sessionsStatus = "Exhausted";
  vi.stubGlobal("crypto", { randomUUID: () => "new-chat" });
  mocks.useQuery.mockReturnValue([
    {
      code: "GH",
      name: "Ghana",
      slug: "ghana",
      enabled: true,
      isDefault: true,
      productionBucketId: "11833",
    },
    {
      code: "NG",
      name: "Nigeria",
      slug: "nigeria",
      enabled: true,
      isDefault: false,
      productionBucketId: "22001",
    },
  ]);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("public home jurisdiction catalog", () => {
  it("loads the governed jurisdictions and selects their configured default", () => {
    render(<Home />);

    expect(screen.getByRole("combobox", { name: "Research jurisdiction" })).toHaveValue("GH");
    expect(screen.getByRole("option", { name: "Nigeria" })).toBeVisible();
  });

  it("explains when the governed catalog loaded without any jurisdictions", () => {
    mocks.useQuery.mockReturnValue([]);

    render(<Home />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Legal research is not available for a jurisdiction right now. Please check again later.",
    );
    expect(screen.getByRole("textbox")).toBeDisabled();
  });

  it("keeps the full landing page visible for an authenticated user with history", () => {
    mocks.auth = { isAuthenticated: true, isLoading: false };
    mocks.sessions = [
      { id: "existing-chat", title: "Tenancy", lastMessage: "", timestamp: 1, messageCount: 1 },
    ];

    render(<Home />);

    expect(mocks.replace).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: "Understand the law where you are." }),
    ).toBeVisible();
    expect(screen.getByRole("form", { name: "Legal research" })).toBeVisible();
  });

  it("disables research while authentication is loading", () => {
    mocks.auth = { isAuthenticated: false, isLoading: true };

    render(<Home />);

    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Research this question" })).toBeDisabled();
  });

  it("disables research while the jurisdiction catalog is loading", () => {
    mocks.useQuery.mockReturnValue(undefined);

    render(<Home />);

    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("returns a stale country selection to the configured default", () => {
    const { rerender } = render(<Home />);
    fireEvent.change(screen.getByRole("combobox", { name: "Research jurisdiction" }), {
      target: { value: "NG" },
    });
    expect(screen.getByRole("combobox", { name: "Research jurisdiction" })).toHaveValue("NG");

    mocks.useQuery.mockReturnValue([
      {
        code: "GH",
        name: "Ghana",
        slug: "ghana",
        isDefault: true,
      },
      {
        code: "ZA",
        name: "South Africa",
        slug: "south-africa",
        isDefault: false,
      },
    ]);
    rerender(<Home />);

    expect(screen.getByRole("combobox", { name: "Research jurisdiction" })).toHaveValue("GH");
  });

  it("preserves the guest question and country through sign-in", () => {
    render(<Home />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Tenant rights?" } });
    fireEvent.click(screen.getByRole("button", { name: "Research this question" }));

    expect(mocks.push).toHaveBeenCalledWith(
      "/signin?redirect=%2Fnew-chat%3Fq%3DTenant%2520rights%253F%26country%3DGH",
    );
  });

  it("sends an authenticated question directly to a country-specific chat", () => {
    mocks.auth = { isAuthenticated: true, isLoading: false };
    render(<Home />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Tenant rights?" } });
    fireEvent.click(screen.getByRole("button", { name: "Research this question" }));

    expect(mocks.push).toHaveBeenCalledWith("/new-chat?q=Tenant%20rights%3F&country=GH");
  });

  it("submits on Enter but not Shift+Enter", () => {
    render(<Home />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Tenant rights?" } });

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(mocks.push).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    expect(mocks.push).toHaveBeenCalledOnce();
  });
});
