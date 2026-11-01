import { describe, expect, it } from "vitest";
import { ALL_LEGAL_REGRESSION_SCENARIOS, checkLegalRegression, COMPARISON_PROMPT_PREFIX,
  COMPARISON_REGRESSION_SCENARIOS, LEGAL_REGRESSION_SCENARIOS } from "../../shared/legal-regression-scenarios";

const scenario = (id: string) => {
  const found = ALL_LEGAL_REGRESSION_SCENARIOS.find(item => item.id === id);
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
    for (const item of ALL_LEGAL_REGRESSION_SCENARIOS) {
      expect(item.turns.length).toBeGreaterThan(0);
      expect(item.checks.length).toBeGreaterThan(0);
      expect(new Set(item.checks.map(check => check.id)).size).toBe(item.checks.length);
    }
  });

  it("covers all 12 comparison questions with the shared instruction", () => {
    expect(COMPARISON_REGRESSION_SCENARIOS).toHaveLength(12);
    expect(new Set(ALL_LEGAL_REGRESSION_SCENARIOS.map(item => item.id)).size)
      .toBe(LEGAL_REGRESSION_SCENARIOS.length + COMPARISON_REGRESSION_SCENARIOS.length);
    for (const item of COMPARISON_REGRESSION_SCENARIOS) expect(item.turns[0].startsWith(COMPARISON_PROMPT_PREFIX)).toBe(true);
  });

  // Paraphrases of the defects recorded in the comparison report, and answers that meet its acceptance checks.
  const comparisonCases: [id: string, observed: string, expectedFailures: string[], fixed: string][] = [
    ["comparison-q4-marital-property-cases",
      "Section 38 of the Land Act presumes that property acquired during marriage is jointly owned. The retrieved passages do not include court decisions.",
      ["names-decision", "s38-conditions"],
      "In Mensah v Mensah the Supreme Court recognised non-cash contributions. Section 38 of the Land Act applies to a conveyance for valuable consideration of an interest jointly acquired during marriage."],
    ["comparison-q7-recording-evidence",
      "I could not retrieve the decisive case law. The interception provisions of the Electronic Communications Act may be relevant.",
      ["names-decision", "discretion"],
      "In Republic v Cubagee the Supreme Court treated the exclusion of such recordings as a matter for the court's discretion."],
    ["comparison-q9-dollar-rent",
      "You can insist on cedis. To be safe, include a clause that references the US dollar rate.",
      ["current-pricing-rules", "no-dollar-clause-advice"],
      "The Bank of Ghana notice of 27 August 2025 addresses quoting and pricing rentals in foreign currency. You can insist on cedis."],
    ["comparison-q10-e-levy",
      "I cannot determine whether the levy remains active.",
      ["reports-repeal", "provider-fees"],
      "The E-Levy was repealed in 2025. Provider fees charged by your mobile money operator are separate and still apply."],
    ["comparison-q11-invented-tenancy-act",
      "That Act does not exist. Section 32 of the Rent Act lets you recover any advance above six months.",
      ["no-absence-as-proof", "s32-pre-commencement"],
      "I could not verify any such Act in the retrieved sources. Section 32 of the Rent Act deals with advances paid before the commencement of the Act, so it does not create a general refund today."],
    ["comparison-q12-inherited-land",
      "You do not have title to the land now. You must first obtain a vesting assent.",
      ["no-adverse-capacity-finding", "representative-role", "grant-status"],
      "It depends on your role. If you are the administrator under letters of administration, you may sell for the estate; if you are a beneficiary, you need the land vested in you first."],
  ];

  it.each(comparisonCases)("flags the observed defect and passes the fix for %s", (id, observed, failing, fixed) => {
    const check = scenario(id);
    expect(checkLegalRegression(check, observed).failures.map(failure => failure.split(":")[0])).toEqual(failing);
    expect(checkLegalRegression(check, fixed).failures).toEqual([]);
  });

  it("passes the answers Law already got right in the comparison", () => {
    expect(checkLegalRegression(scenario("comparison-q1-maternity-leave"),
      "Section 57 of the Labour Act gives at least 12 weeks' maternity leave on full pay.").failures).toEqual([]);
    expect(checkLegalRegression(scenario("comparison-q6-marketing-texts"),
      "Direct marketing needs your prior written consent. You can complain to the Data Protection Commission.").failures).toEqual([]);
    expect(checkLegalRegression(scenario("comparison-q2-rent-advance"),
      "A landlord may not demand more than six months' rent in advance. The penalty is 25 penalty units.").failures)
      .toEqual(["no-unreconciled-penalty: States a precise penalty without noting that official texts differ."]);
  });
});
