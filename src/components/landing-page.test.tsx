import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LandingPage } from "./landing-page";

afterEach(cleanup);

describe("public jurisdiction selector", () => {
  it("renders every enabled jurisdiction supplied by the governed catalog", () => {
    const props = {
      query: "",
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
      jurisdictions: [
        { code: "GH", name: "Ghana", slug: "ghana", isDefault: true },
        { code: "NG", name: "Nigeria", slug: "nigeria", isDefault: false },
      ],
    };

    render(<LandingPage {...props} />);

    expect(screen.getByRole("combobox", { name: "Country" })).toHaveValue("GH");
    expect(screen.getByRole("option", { name: "Ghana" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Nigeria" })).toBeVisible();
  });
});
