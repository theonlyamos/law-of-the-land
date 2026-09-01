import { describe, expect, it } from "vitest";
import {
  chooseJurisdictionCode,
  findCountry,
  findJurisdiction,
  type PublicJurisdiction,
  type ResearchJurisdiction,
  legacyCountryCodeForSelection,
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

describe("unified jurisdiction compatibility navigation", () => {
  it("returns only a validated uppercase legacy snapshot", () => {
    const ghana: ResearchJurisdiction = {
      id: "jurisdiction-ghana",
      name: "Ghana",
      slug: "ghana",
      kind: "geographic",
      isDefault: true,
      legacyCountryCode: "GH",
    };

    expect(legacyCountryCodeForSelection(ghana)).toBe("GH");
    expect(legacyCountryCodeForSelection({ ...ghana, legacyCountryCode: "gh" })).toBeNull();
    expect(legacyCountryCodeForSelection({ ...ghana, legacyCountryCode: undefined })).toBeNull();
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
