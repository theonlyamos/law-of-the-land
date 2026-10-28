import { describe, expect, it } from "vitest";
import { checkLegalRegression, LEGAL_REGRESSION_SCENARIOS } from "../../shared/legal-regression-scenarios";

const scenario = (id: string) => {
  const found = LEGAL_REGRESSION_SCENARIOS.find(item => item.id === id);
  if (!found) throw new Error(`missing scenario ${id}`);
  return found;
};

describe("legal regression scenarios", () => {
  it("flags the fixed-term answer observed in the overnight QA run", () => {
    const observed = "Your notice period is now one month. Section 63 of the Labour Act protects all workers from unfair termination, so you can seek relief under section 64.";
    expect(checkLegalRegression(scenario("employment-fixed-term-exclusion"), observed).failures).toEqual([
      "assesses-section-66: Does not assess the section 66 exclusion for specified-period contracts.",
      "no-all-workers-claim: Claims section 63 protects all workers.",
    ]);
  });

  it("passes a fixed-term answer that assesses the section 66 exclusion", () => {
    const expected = "Section 66 of the Labour Act excludes a worker employed for a specified period from Part VIII, so the statutory unfair-termination route may not apply. Contractual remedies for early termination still need to be assessed.";
    expect(checkLegalRegression(scenario("employment-fixed-term-exclusion"), expected).failures).toEqual([]);
  });

  it("flags an unreconciled Order 66 penalty and passes a reconciled one", () => {
    const check = scenario("intestacy-intermeddling-currentness");
    expect(checkLegalRegression(check, "Under Order 66 rule 3 of C.I. 47, intermeddling is an offence punishable by up to two years' imprisonment.").failures)
      .toHaveLength(1);
    expect(checkLegalRegression(check, "Order 66 rule 3 described a two-year imprisonment penalty, but the Supreme Court held in 2023 that the rule could not create that offence.").failures)
      .toEqual([]);
    expect(checkLegalRegression(check, "Section 17 of PNDCL 111 addresses ejection of a spouse.").failures).toEqual([]);
  });

  it("flags invented content for a fabricated Act", () => {
    const check = scenario("fabricated-act-refusal");
    expect(checkLegalRegression(check, "Section 999 provides that landlords may evict at night.").failures).toHaveLength(1);
    expect(checkLegalRegression(check, "The retrieved passages do not establish any section 999 of that Act.").failures).toEqual([]);
  });

  it("keeps every scenario runnable", () => {
    for (const item of LEGAL_REGRESSION_SCENARIOS) {
      expect(item.turns.length).toBeGreaterThan(0);
      expect(item.checks.length).toBeGreaterThan(0);
      expect(new Set(item.checks.map(check => check.id)).size).toBe(item.checks.length);
    }
  });
});
