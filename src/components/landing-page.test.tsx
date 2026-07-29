import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LandingPage } from "./landing-page";

vi.mock("@/components/auth/user-nav", () => ({
  UserNav: () => <span>Account controls</span>,
}));

vi.mock("next/image", () => ({
  default: ({ alt, className }: { alt: string; className?: string }) => (
    <img alt={alt} className={className} />
  ),
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

  it("shows up to three authenticated recent sessions and resumes the selected session", () => {
    const props = landingProps({
      isAuthenticated: true,
      savedChats: [
        {
          id: "chat-tenancy",
          title: "Tenancy",
          lastMessage: "Notice periods",
          timestamp: new Date("2026-07-29T12:00:00Z"),
          messageCount: 2,
          messages: [],
        },
        {
          id: "chat-consumer",
          title: "Consumer rights",
          lastMessage: "Refund rules",
          timestamp: new Date("2026-07-28T12:00:00Z"),
          messageCount: 2,
          messages: [],
        },
        {
          id: "chat-employment",
          title: "Employment",
          lastMessage: "Notice requirements",
          timestamp: new Date("2026-07-27T12:00:00Z"),
          messageCount: 2,
          messages: [],
        },
        {
          id: "chat-hidden",
          title: "Fourth session",
          lastMessage: "Should not render",
          timestamp: new Date("2026-07-26T12:00:00Z"),
          messageCount: 2,
          messages: [],
        },
      ],
    });

    render(<LandingPage {...props} />);

    const recentResearch = screen.getByRole("region", { name: "Recent research" });
    expect(within(recentResearch).getByRole("button", { name: "Tenancy" })).toBeVisible();
    expect(within(recentResearch).getByRole("button", { name: "Consumer rights" })).toBeVisible();
    expect(within(recentResearch).getByRole("button", { name: "Employment" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Fourth session" })).not.toBeInTheDocument();

    fireEvent.click(within(recentResearch).getByRole("button", { name: "Consumer rights" }));
    expect(props.onResumeChat).toHaveBeenCalledWith("chat-consumer");
  });

  it("renders the approved editorial sections from the governed jurisdiction register", () => {
    render(<LandingPage {...landingProps()} />);

    for (const heading of [
      "Clear explanations. Verifiable sources.",
      "Built for everyday questions and professional research.",
      "Coverage grows through governed publication.",
      "Research that remains available when you return.",
    ]) {
      expect(screen.getByRole("heading", { name: heading })).toBeVisible();
    }

    const coverage = screen.getByRole("region", { name: "Published jurisdiction coverage" });
    expect(within(coverage).getByText("Ghana")).toBeVisible();
    expect(within(coverage).getByText("Nigeria")).toBeVisible();
    expect(screen.queryByText(/countries covered/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Illustrative source trail")).toHaveTextContent(
      "Act or regulation \u00b7 Section or article",
    );
  });

  it("uses only valid page destinations and explains continuity to guests", () => {
    render(<LandingPage {...landingProps()} />);

    expect(screen.getByRole("link", { name: "Review plans" })).toHaveAttribute(
      "href",
      "/signin?redirect=%2Fsettings%2Fbilling",
    );
    expect(screen.getByRole("link", { name: "Choose a jurisdiction" })).toHaveAttribute(
      "href",
      "#research",
    );
    expect(screen.getByRole("form", { name: "Legal research" })).toHaveAttribute(
      "tabindex",
      "-1",
    );
    expect(screen.getByText(/Sign in to save research threads/i)).toBeVisible();
    expect(screen.queryByRole("link", { name: "Session controls" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /privacy/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /terms/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /contact/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Legal notice" })).toHaveAttribute(
      "href",
      "#legal-information-notice",
    );
  });

  it("uses the brand logo in the footer home link", () => {
    render(<LandingPage {...landingProps()} />);

    const homeLinks = screen.getAllByRole("link", { name: "Law of the Land home" });
    const footerHomeLink = homeLinks.at(-1);

    expect(footerHomeLink).toBeDefined();
    expect(within(footerHomeLink!).getByAltText("")).toBeVisible();
  });

  it("links authenticated plans and session controls to settings", () => {
    render(<LandingPage {...landingProps({ isAuthenticated: true })} />);

    expect(screen.getByRole("link", { name: "Review plans" })).toHaveAttribute(
      "href",
      "/settings/billing",
    );
    expect(screen.getByRole("link", { name: "Session controls" })).toHaveAttribute(
      "href",
      "/settings/sessions",
    );
  });

  it("explains when no governed jurisdiction is available and blocks research", () => {
    render(<LandingPage {...landingProps({ country: "", jurisdictions: [] })} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Legal research is not available for a jurisdiction right now. Please check again later.",
    );
    expect(screen.getByRole("button", { name: "Research this question" })).toBeDisabled();
    expect(
      screen.getAllByText(
        "Legal research is not available for a jurisdiction right now. Please check again later.",
      ),
    ).toHaveLength(2);
  });

  it("labels the published register while jurisdiction data is loading", () => {
    render(<LandingPage {...landingProps({ country: "", jurisdictions: undefined })} />);

    expect(screen.getByText("Loading the published jurisdiction register\u2026")).toBeVisible();
  });
});
