import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
  auth: { isAuthenticated: false, isLoading: false },
  sessions: [] as Array<{
    id: string;
    title: string;
    lastMessage: string;
    timestamp: number;
    messageCount: number;
  }>,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, push: mocks.push }),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => mocks.auth,
  usePaginatedQuery: () => ({ results: mocks.sessions, status: "Exhausted" }),
  useQuery: () => undefined,
}));

vi.mock("@/components/jurisdictions/research-jurisdiction-picker", () => ({
  ResearchJurisdictionPicker: ({ onChange }: { onChange: (value: unknown) => void }) => (
    <>
      <button type="button" onClick={() => onChange({ id: "ghana-id", name: "Ghana", slug: "ghana", kind: "geographic", isDefault: true })}>
        Choose Ghana
      </button>
      <button type="button" onClick={() => onChange({ id: "university-id", name: "Private University", slug: "private-university", kind: "organizational", isDefault: false })}>
        Choose organization
      </button>
    </>
  ),
}));

import Home from "./page";

beforeEach(() => {
  mocks.replace.mockReset();
  mocks.push.mockReset();
  mocks.auth = { isAuthenticated: false, isLoading: false };
  mocks.sessions = [];
  vi.stubGlobal("crypto", { randomUUID: () => "new-chat" });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("public home jurisdiction selection", () => {
  it("always uses the unified jurisdiction picker", () => {
    render(<Home />);

    expect(screen.getByRole("button", { name: "Choose Ghana" })).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "Research jurisdiction" })).not.toBeInTheDocument();
  });

  it("preserves a guest question and stable jurisdiction ID through sign-in", () => {
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "Choose Ghana" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Tenant rights?" } });
    fireEvent.click(screen.getByRole("button", { name: "Research this question" }));

    expect(mocks.push).toHaveBeenCalledWith(
      "/signin?redirect=%2Fnew-chat%3Fq%3DTenant%2520rights%253F%26jurisdiction%3Dghana-id",
    );
  });

  it("starts an authenticated organization chat with only its stable ID", () => {
    mocks.auth = { isAuthenticated: true, isLoading: false };
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "Choose organization" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Employment policy?" } });
    fireEvent.click(screen.getByRole("button", { name: "Research this question" }));

    expect(mocks.push).toHaveBeenCalledWith(
      "/new-chat?q=Employment%20policy%3F&jurisdiction=university-id",
    );
  });

  it("disables research while authentication is loading", () => {
    mocks.auth = { isAuthenticated: false, isLoading: true };
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "Choose Ghana" }));

    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Research this question" })).toBeDisabled();
  });

  it("keeps the full landing page and saved chat navigation", () => {
    mocks.auth = { isAuthenticated: true, isLoading: false };
    mocks.sessions = [
      { id: "existing-chat", title: "Tenancy", lastMessage: "", timestamp: 1, messageCount: 1 },
    ];
    render(<Home />);

    const landing = screen.getByRole("main");
    expect(landing.parentElement).not.toHaveClass("container");
    expect(screen.getByRole("heading", { name: "Understand the law where you are." })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Tenancy" }));
    expect(mocks.push).toHaveBeenCalledWith("/existing-chat");
  });

  it("submits on Enter but not Shift+Enter", () => {
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "Choose Ghana" }));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Tenant rights?" } });

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(mocks.push).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    expect(mocks.push).toHaveBeenCalledOnce();
  });
});
