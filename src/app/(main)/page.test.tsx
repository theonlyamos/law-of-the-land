import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicJurisdiction } from "@/lib/countries";
import { getFunctionName, type FunctionReference } from "convex/server";

const publicJurisdictions: PublicJurisdiction[] = [
  {
    code: "GH",
    name: "Ghana",
    slug: "ghana",
    isDefault: true,
  },
  {
    code: "NG",
    name: "Nigeria",
    slug: "nigeria",
    isDefault: false,
  },
];

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
  unifiedEnabled: false as boolean | undefined,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, push: mocks.push }),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => mocks.auth,
  usePaginatedQuery: () => ({ results: mocks.sessions, status: mocks.sessionsStatus }),
  useQuery: mocks.useQuery,
}));

vi.mock("@/components/jurisdictions/research-jurisdiction-picker", () => ({
  ResearchJurisdictionPicker: ({ onChange }: { onChange: (value: unknown) => void }) => (
    <button
      type="button"
      onClick={() =>
        onChange({
          id: "ghana-id",
          name: "Ghana",
          slug: "ghana",
          kind: "geographic",
          isDefault: true,
          legacyCountryCode: "GH",
        })
      }
    >
      Choose Ghana unified
    </button>
  ),
}));

import Home from "./page";

beforeEach(() => {
  mocks.replace.mockReset();
  mocks.push.mockReset();
  mocks.useQuery.mockReset();
  mocks.auth = { isAuthenticated: false, isLoading: false };
  mocks.sessions = [];
  mocks.sessionsStatus = "Exhausted";
  mocks.unifiedEnabled = false;
  vi.stubGlobal("crypto", { randomUUID: () => "new-chat" });
  mocks.useQuery.mockImplementation((reference: FunctionReference<"query">, args?: unknown) => {
    const name = getFunctionName(reference);
    if (name === "jurisdictions:isUnifiedJurisdictionsEnabled") return mocks.unifiedEnabled;
    if (name === "jurisdictions:listPublicEnabled") {
      return args === "skip" ? undefined : publicJurisdictions;
    }
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("public home jurisdiction catalog", () => {
  it("lets the landing composition span and scroll across the full page", () => {
    render(<Home />);

    const landing = screen.getByRole("main");
    expect(landing.parentElement).not.toHaveClass("container");
    expect(landing.parentElement).not.toHaveClass("overflow-hidden");
  });

  it("loads the governed jurisdictions and selects their configured default", () => {
    render(<Home />);

    expect(screen.getByRole("combobox", { name: "Research jurisdiction" })).toHaveValue("GH");
    expect(screen.getByRole("option", { name: "Nigeria" })).toBeVisible();
  });

  it("explains when the governed catalog loaded without any jurisdictions", () => {
    mocks.useQuery.mockImplementation((reference: FunctionReference<"query">, args?: unknown) => {
      const name = getFunctionName(reference);
      if (name === "jurisdictions:isUnifiedJurisdictionsEnabled") return false;
      return args === "skip" ? undefined : [];
    });

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
    fireEvent.click(screen.getByRole("button", { name: "Tenancy" }));
    expect(mocks.push).toHaveBeenCalledWith("/existing-chat");
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("disables research while authentication is loading", () => {
    mocks.auth = { isAuthenticated: false, isLoading: true };

    render(<Home />);

    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Research this question" })).toBeDisabled();
  });

  it("disables research while the jurisdiction catalog is loading", () => {
    mocks.unifiedEnabled = undefined;

    render(<Home />);

    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Loading jurisdiction access…");
  });

  it("returns a stale country selection to the configured default", () => {
    const { rerender } = render(<Home />);
    fireEvent.change(screen.getByRole("combobox", { name: "Research jurisdiction" }), {
      target: { value: "NG" },
    });
    expect(screen.getByRole("combobox", { name: "Research jurisdiction" })).toHaveValue("NG");

    const updated = [
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
    ];
    mocks.useQuery.mockImplementation((reference: FunctionReference<"query">, args?: unknown) => {
      const name = getFunctionName(reference);
      if (name === "jurisdictions:isUnifiedJurisdictionsEnabled") return false;
      return args === "skip" ? undefined : updated;
    });
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

  it("skips the legacy full catalog and preserves Ghana compatibility when unified selection is on", () => {
    mocks.unifiedEnabled = true;
    render(<Home />);

    expect(screen.queryByRole("combobox", { name: "Research jurisdiction" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Choose Ghana unified" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Tenant rights?" } });
    fireEvent.click(screen.getByRole("button", { name: "Research this question" }));

    expect(mocks.push).toHaveBeenCalledWith(
      "/signin?redirect=%2Fnew-chat%3Fq%3DTenant%2520rights%253F%26country%3DGH",
    );
    expect(
      mocks.useQuery.mock.calls.some(
        ([reference, args]) =>
          getFunctionName(reference as FunctionReference<"query">) ===
            "jurisdictions:listPublicEnabled" && args === "skip",
      ),
    ).toBe(true);
  });
});
