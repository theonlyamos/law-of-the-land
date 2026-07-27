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
    expect(screen.queryByLabelText("Repeal date")).toBeNull();
  });

  it("bounds jurisdiction options and exposes exact-code search and cursor navigation", () => {
    const jurisdictions = Array.from({ length: 25 }, (_, index) => ({
      id: `jurisdiction_${index + 1}`,
      code: `X${String(index).padStart(2, "0")}`,
      name: `Jurisdiction ${index + 1}`,
    }));
    render(
      <ResourceEditor
        jurisdictionIds={jurisdictions.map((row) => row.id)}
        jurisdictionOptions={jurisdictions}
        jurisdictionPicker={{ searchCode: "", nextCursor: "cursor-25", isDone: false }}
      />,
    );
    const jurisdictionSelect = screen.getByLabelText("Jurisdiction ID");
    expect(jurisdictionSelect.querySelectorAll("option")).toHaveLength(25);
    expect(screen.getByRole("textbox", { name: "Find jurisdiction by ISO code" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Next jurisdictions" })).toHaveAttribute(
      "href",
      "/admin/documents?jurisdictionCursor=cursor-25",
    );
  });
});
