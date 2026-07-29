import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
  useQuery: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, push: mocks.push }),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: false, isLoading: false }),
  usePaginatedQuery: () => ({ results: [], status: "Exhausted" }),
  useQuery: mocks.useQuery,
}));

import Home from "./page";

beforeEach(() => {
  mocks.replace.mockReset();
  mocks.push.mockReset();
  mocks.useQuery.mockReset();
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

afterEach(cleanup);

describe("public home jurisdiction catalog", () => {
  it("loads the governed jurisdictions and selects their configured default", () => {
    render(<Home />);

    expect(screen.getByRole("combobox", { name: "Country" })).toHaveValue("GH");
    expect(screen.getByRole("option", { name: "Nigeria" })).toBeVisible();
  });

  it("explains when the governed catalog loaded without any jurisdictions", () => {
    mocks.useQuery.mockReturnValue([]);

    render(<Home />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "No jurisdictions are currently available",
    );
    expect(screen.getByRole("textbox")).toBeDisabled();
  });
});
