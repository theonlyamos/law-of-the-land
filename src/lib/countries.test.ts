import { describe, expect, it } from "vitest";
import {
  chooseJurisdictionCode,
  findCountry,
  findJurisdiction,
  type PublicJurisdiction,
} from "./countries";

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

describe("public jurisdiction metadata", () => {
  const jurisdictions: PublicJurisdiction[] = [
    { code: "NG", name: "Nigeria", slug: "nigeria", isDefault: true },
    { code: "GH", name: "Ghana", slug: "ghana", isDefault: false },
  ];

  it("resolves jurisdiction codes without case sensitivity", () => {
    expect(findJurisdiction(jurisdictions, "gh")?.name).toBe("Ghana");
  });

  it("keeps a current jurisdiction selection when it remains enabled", () => {
    expect(chooseJurisdictionCode(jurisdictions, "GH")).toBe("GH");
  });

  it("falls back to the configured default for a stale selection", () => {
    expect(chooseJurisdictionCode(jurisdictions, "CI")).toBe("NG");
  });

  it("returns an empty code without any available jurisdiction", () => {
    expect(chooseJurisdictionCode([], "GH")).toBe("");
  });
});
