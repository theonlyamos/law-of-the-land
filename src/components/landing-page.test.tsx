import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LandingPage } from "./landing-page";

vi.mock("@/components/auth/user-nav", () => ({
  UserNav: () => <span>Account controls</span>,
}));

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <span aria-label={alt} />,
}));

afterEach(cleanup);

const jurisdictions = [
  { code: "GH", name: "Ghana", slug: "ghana", isDefault: true },
  { code: "NG", name: "Nigeria", slug: "nigeria", isDefault: false },
];

function landingProps(overrides: Partial<React.ComponentProps<typeof LandingPage>> = {}) {
  return {
    query: "What notice must a landlord give?",
    onQueryChange: vi.fn(),
    onSearch: vi.fn(),
    onPickSuggested: vi.fn(),
    onKeyDown: vi.fn(),
    isLoading: false,
    savedChats: [],
    onResumeChat: vi.fn(),
    isAuthenticated: false,
    country: "GH",
    onCountryChange: vi.fn(),
    jurisdictions,
    ...overrides,
  };
}

describe("professional landing research shell", () => {
  it("presents one semantic main with approved positioning and destinations", () => {
    render(<LandingPage {...landingProps()} />);

    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(
      screen.getByRole("heading", { level: 1, name: "Understand the law where you are." }),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Ask a question in plain language. Receive a clear, jurisdiction-specific answer with the legal sources and citations needed to verify it.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("form", { name: "Legal research" })).toBeVisible();
    expect(screen.getByText("Research jurisdiction")).toBeVisible();
    expect(screen.getByText("Your legal question")).toBeVisible();
    expect(screen.getByRole("button", { name: "Research this question" })).toBeVisible();
    const legalNotice = screen.getByRole("complementary", {
      name: "Legal information disclaimer",
    });
    expect(within(legalNotice).getByText("Legal information, not legal advice")).toBeVisible();
    expect(legalNotice).toHaveTextContent(
      "Law of the Land helps you understand published legal sources. It cannot assess every fact in your situation or replace advice from a qualified legal professional.",
    );

    const primaryNavigation = screen.getByRole("navigation", { name: "Primary navigation" });
    expect(primaryNavigation).toContainElement(
      screen.getByRole("link", { name: "Jurisdictions" }),
    );
    expect(screen.getByRole("link", { name: "Jurisdictions" })).toHaveAttribute(
      "href",
      "#jurisdictions",
    );
    expect(screen.getByRole("link", { name: "How it works" })).toHaveAttribute(
      "href",
      "#how-it-works",
    );
    expect(screen.getByRole("link", { name: "For professionals" })).toHaveAttribute(
      "href",
      "#for-professionals",
    );
    expect(screen.getByRole("link", { name: "Plans" })).toHaveAttribute("href", "#plans");
  });

  it("uses the governed catalog and submits the controlled research question", () => {
    const props = landingProps();

    render(<LandingPage {...props} />);

    const selector = screen.getByRole("combobox", { name: "Research jurisdiction" });
    expect(selector).toHaveValue("GH");
    expect(screen.getByRole("option", { name: "Ghana" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Nigeria" })).toBeVisible();
    fireEvent.change(selector, { target: { value: "NG" } });
    expect(props.onCountryChange).toHaveBeenCalledWith("NG");

    fireEvent.change(screen.getByRole("textbox", { name: "Your legal question" }), {
      target: { value: "What are the notice rules?" },
    });
    expect(props.onQueryChange).toHaveBeenCalledWith("What are the notice rules?");

    fireEvent.click(screen.getByRole("button", { name: "Research this question" }));
    expect(props.onSearch).toHaveBeenCalledTimes(1);
  });

  it("explains when no governed jurisdiction is available and blocks research", () => {
    render(<LandingPage {...landingProps({ country: "", jurisdictions: [] })} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Legal research is not available for a jurisdiction right now. Please check again later.",
    );
    expect(screen.getByRole("button", { name: "Research this question" })).toBeDisabled();
  });
});
