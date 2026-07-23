import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import AdminLoading from "./loading";

afterEach(cleanup);

describe("admin route loading boundary", () => {
  it("announces loading during real server navigation and respects reduced motion", () => {
    render(<AdminLoading />);

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveTextContent("Loading administration records");
    expect(status.querySelector(".animate-pulse")).toHaveClass(
      "motion-reduce:animate-none",
    );
  });
});
