import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JurisdictionEditor, ResourceEditor } from "./catalog-actions";

vi.mock("convex/react", () => ({ useMutation: () => vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

afterEach(cleanup);

describe("catalog mutation controls", () => {
  it("offers explicit jurisdiction fields and named lifecycle actions", () => {
    render(<JurisdictionEditor />);
    expect(screen.getByRole("textbox", { name: "ISO country code" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Audit reason" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Create draft jurisdiction" })).toBeVisible();

    cleanup();
    render(<JurisdictionEditor jurisdiction={{
      id: "jurisdiction_1",
      code: "GH",
      name: "Ghana",
      slug: "ghana",
      status: "draft",
      isDefault: true,
      stagingBucketId: "stage-gh",
      productionBucketId: "prod-gh",
    }} />);
    expect(screen.getByRole("button", { name: "Enable jurisdiction" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Archive jurisdiction" })).toBeVisible();
  });

  it("offers canonical resource editing without arbitrary status input", () => {
    render(<ResourceEditor jurisdictionIds={["jurisdiction_1"]} />);
    expect(screen.getByRole("textbox", { name: "Official citation" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Create legal resource" })).toBeVisible();
    expect(screen.queryByLabelText("Status")).toBeNull();
  });
});
