import { describe, expect, it } from "vitest";
import { findCountry } from "./countries";

describe("governed country metadata", () => {
  it("resolves a code from the runtime jurisdiction catalog", () => {
    const countries = [
      { code: "GH", name: "Ghana" },
      { code: "NG", name: "Nigeria" },
    ];

    expect(findCountry(countries, "ng")).toEqual({
      code: "NG",
      name: "Nigeria",
    });
    expect(findCountry(countries, "CI")).toBeNull();
  });
});
