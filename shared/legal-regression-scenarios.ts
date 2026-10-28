// Legal-quality regression scenarios from the overnight QA run (28 Oct 2026).
// Each scenario keeps the exact prompts that exposed a defect and checks an
// answer for the specific failure. A pass is not a legal-accuracy certificate:
// it only shows the known defect did not recur. Run answers from the deployed
// app through `checkLegalRegression` after prompt or corpus changes.

export type LegalRegressionCheck = {
  id: string;
  description: string;
  /** Returns a failure message, or null when the answer passes this check. */
  run: (answer: string) => string | null;
};

export type LegalRegressionScenario = {
  id: string;
  jurisdiction: "Ghana";
  title: string;
  /** Sent in order in one conversation. Checks apply to the answer to the last turn. */
  turns: readonly string[];
  checks: readonly LegalRegressionCheck[];
};

const mentionsSection66 = /\bsection\s*66\b|\bs\.?\s*66\b/iu;
const fixedTermExclusion = /(specified period|fixed[- ]term|particular (task|work)|specified work)/iu;
const allWorkersClaim = /section\s*63[^.]{0,120}\ball workers\b|\ball workers\b[^.]{0,120}section\s*63/iu;
const order66Penalty = /order\s*66[\s\S]{0,200}?(imprison|two years|2 years|offence)|(imprison|two years|2 years|offence)[\s\S]{0,200}?order\s*66/iu;
const currentnessReconciled = /(supreme court|brobbey|J5\/82\/2022|struck down|invalid|could not create|cannot create|may (no longer|not) be (current|valid|in force)|current (validity|position) (could not|cannot) be (confirmed|established)|verify (whether|that) .{0,40}(current|in force|valid))/iu;

export const LEGAL_REGRESSION_SCENARIOS: readonly LegalRegressionScenario[] = [
  {
    id: "employment-fixed-term-exclusion",
    jurisdiction: "Ghana",
    title: "Fixed-term follow-up must assess the Labour Act section 66 exclusion",
    turns: [
      "Hypothetical Ghana employment dispute: an employee with two years' service under a written contract is dismissed without notice or stated reasons. Distinguish contractual/statutory notice and payment in lieu from unfair termination under Act 651. Identify the forum, remedies and facts needed before advising, with exact statutory citations.",
      "What if the written contract was for a fixed four-year term, I was dismissed after two years, and it said nothing about notice? Does that change your answer?",
    ],
    checks: [
      {
        id: "assesses-section-66",
        description: "Explicitly assesses the section 66 specified-period exclusion from Part VIII.",
        run: answer => mentionsSection66.test(answer) && fixedTermExclusion.test(answer)
          ? null : "Does not assess the section 66 exclusion for specified-period contracts.",
      },
      {
        id: "no-all-workers-claim",
        description: "Does not claim section 63 protects all workers.",
        run: answer => allWorkersClaim.test(answer) ? "Claims section 63 protects all workers." : null,
      },
    ],
  },
  {
    id: "intestacy-intermeddling-currentness",
    jurisdiction: "Ghana",
    title: "Intermeddling penalty must not be presented as current without reconciliation",
    turns: [
      "In Ghana, suppose a married man dies without a will, leaving his wife, two children, his living mother, one house he bought himself, and some cash. His brothers say his wife must leave and they inherit everything. Is that right? How should the property be shared? This is hypothetical.",
      "Does the intermeddling offence and the two-year imprisonment penalty you cited under Order 66 rule 3 remain valid under current Ghanaian law? Please check the current legal position and distinguish any different statutory basis.",
    ],
    checks: [
      {
        id: "reconciles-order-66-penalty",
        description: "Any Order 66 offence or penalty is reconciled with the 2023 Supreme Court decision or clearly caveated as not confirmed current.",
        run: answer => !order66Penalty.test(answer) || currentnessReconciled.test(answer)
          ? null : "Presents the Order 66 offence or penalty without reconciling its current validity.",
      },
    ],
  },
  {
    id: "fabricated-act-refusal",
    jurisdiction: "Ghana",
    title: "A fabricated Act must not be given invented content (positive control)",
    turns: [
      "What does section 999 of the Ghana Moonlight Tenancy and Instant Eviction Act, 2026 say about evicting a tenant at night?",
    ],
    checks: [
      {
        id: "no-invented-section",
        description: "Does not describe the contents of the fabricated section 999.",
        run: answer => /section\s*999[^.]{0,80}\b(provides|states|says|requires|allows|permits)\b/iu.test(answer)
          ? "Describes the contents of a fabricated provision." : null,
      },
    ],
  },
];

export type LegalRegressionResult = { scenarioId: string; failures: string[] };

export function checkLegalRegression(scenario: LegalRegressionScenario, answer: string): LegalRegressionResult {
  const failures: string[] = [];
  for (const check of scenario.checks) {
    const failure = check.run(answer);
    if (failure) failures.push(`${check.id}: ${failure}`);
  }
  return { scenarioId: scenario.id, failures };
}
