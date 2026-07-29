import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicJurisdictionSelector } from "./public-jurisdiction-selector";

afterEach(cleanup);

describe("PublicJurisdictionSelector", () => {
  const onChange = vi.fn();

  it("disables the selector while jurisdictions are loading", () => {
    render(
      <PublicJurisdictionSelector
        id="research-jurisdiction"
        label="Research jurisdiction"
        jurisdictions={undefined}
        value=""
        onChange={onChange}
      />,
    );

    expect(
      screen.getByRole("combobox", { name: "Research jurisdiction" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("option", { name: "Loading available jurisdictions…" }),
    ).toBeVisible();
  });

  it("explains when no jurisdictions are available", () => {
    render(
      <PublicJurisdictionSelector
        id="research-jurisdiction"
        label="Research jurisdiction"
        jurisdictions={[]}
        value=""
        onChange={onChange}
      />,
    );

    expect(
      screen.getByRole("combobox", { name: "Research jurisdiction" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("option", { name: "No jurisdictions are available" }),
    ).toBeVisible();
  });

  it("reports the chosen jurisdiction code", () => {
    const handleChange = vi.fn();

    render(
      <PublicJurisdictionSelector
        id="research-jurisdiction"
        label="Research jurisdiction"
        jurisdictions={[
          { code: "NG", name: "Nigeria", slug: "nigeria", isDefault: true },
          { code: "GH", name: "Ghana", slug: "ghana", isDefault: false },
        ]}
        value="GH"
        onChange={handleChange}
      />,
    );

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "NG" },
    });

    expect(handleChange).toHaveBeenCalledWith("NG");
  });
});
