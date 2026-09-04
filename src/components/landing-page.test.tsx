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

vi.mock("@/components/jurisdictions/research-jurisdiction-picker", () => ({
  ResearchJurisdictionPicker: ({ onChange }: { onChange: (value: unknown) => void }) => (
    <div>
      <span>Research jurisdiction</span>
      <button
        type="button"
        onClick={() => onChange({ id: "ghana-id", name: "Ghana", slug: "ghana", kind: "geographic", isDefault: true })}
      >
        Choose Ghana
      </button>
    </div>
  ),
}));

afterEach(cleanup);

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
    researchJurisdiction: {
      id: "ghana-id",
      name: "Ghana",
      slug: "ghana",
      kind: "geographic" as const,
      isDefault: true,
    },
    onResearchJurisdictionChange: vi.fn(),
    ...overrides,
  };
}

describe("professional landing research shell", () => {
  it("presents one semantic main with the approved destinations and notice", () => {
    render(<LandingPage {...landingProps()} />);

    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Understand the law where you are." })).toBeVisible();
    expect(screen.getByRole("form", { name: "Legal research" })).toBeVisible();
    expect(screen.getByText("Research jurisdiction")).toBeVisible();
    expect(screen.getByRole("link", { name: "Jurisdictions" })).toHaveAttribute("href", "#jurisdictions");
    expect(screen.getByRole("link", { name: "Plans" })).toHaveAttribute("href", "#plans");
    expect(screen.getByRole("complementary", { name: "Legal information disclaimer" })).toHaveTextContent(
      "Legal information, not legal advice",
    );
  });

  it("uses the unified picker and submits the controlled question", () => {
    const props = landingProps();
    render(<LandingPage {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Choose Ghana" }));
    expect(props.onResearchJurisdictionChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ghana-id" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Your legal question" }), {
      target: { value: "What are the notice rules?" },
    });
    expect(props.onQueryChange).toHaveBeenCalledWith("What are the notice rules?");
    fireEvent.click(screen.getByRole("button", { name: "Research this question" }));
    expect(props.onSearch).toHaveBeenCalledOnce();
  });

  it("requires a stable jurisdiction selection before research", () => {
    render(<LandingPage {...landingProps({ researchJurisdiction: null })} />);
    expect(screen.getByRole("button", { name: "Research this question" })).toBeDisabled();
  });

  it("shows up to three authenticated recent sessions and resumes the selected session", () => {
    const props = landingProps({
      isAuthenticated: true,
      savedChats: ["Tenancy", "Consumer rights", "Employment", "Fourth session"].map((title, index) => ({
        id: `chat-${index}`,
        title,
        lastMessage: "Answer",
        timestamp: new Date(index),
        messageCount: 2,
        messages: [],
      })),
    });
    render(<LandingPage {...props} />);

    const recentResearch = screen.getByRole("region", { name: "Recent research" });
    expect(within(recentResearch).getByRole("button", { name: "Tenancy" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Fourth session" })).not.toBeInTheDocument();
    fireEvent.click(within(recentResearch).getByRole("button", { name: "Consumer rights" }));
    expect(props.onResumeChat).toHaveBeenCalledWith("chat-1");
  });

  it("shows search-first coverage instead of the legacy full register", () => {
    render(<LandingPage {...landingProps()} />);

    expect(screen.getByText(/Search by place or organization/i)).toBeVisible();
    expect(screen.queryByText("Nigeria")).not.toBeInTheDocument();
  });

  it("links guest and authenticated plan destinations correctly", () => {
    const { rerender } = render(<LandingPage {...landingProps()} />);
    expect(screen.getByRole("link", { name: "Review plans" })).toHaveAttribute(
      "href",
      "/signin?redirect=%2Fsettings%2Fbilling",
    );

    rerender(<LandingPage {...landingProps({ isAuthenticated: true })} />);
    expect(screen.getByRole("link", { name: "Review plans" })).toHaveAttribute("href", "/settings/billing");
    expect(screen.getByRole("link", { name: "Session controls" })).toHaveAttribute("href", "/settings/sessions");
  });

  it("uses the brand logo in the footer home link", () => {
    render(<LandingPage {...landingProps()} />);
    const footerHomeLink = screen.getAllByRole("link", { name: "Law of the Land home" }).at(-1);
    expect(footerHomeLink).toBeDefined();
    expect(within(footerHomeLink!).getByAltText("")).toBeVisible();
  });
});
