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

// Comparison test against another Ghana legal assistant (1 Nov 2026). Each prompt
// was sent in a fresh chat after the same instruction. Checks target the defects
// and strengths the report recorded, so a regression on a question Law already
// answered well shows up as clearly as a fix for one it got wrong.
export const COMPARISON_PROMPT_PREFIX = "Please answer for Ghana, using the law in force on 1 November 2026. Explain in plain English and give sources I can check. If you cannot verify something, say so.";
const comparisonTurn = (question: string) => `${COMPARISON_PROMPT_PREFIX}\n\n${question}`;

const sentences = (answer: string) => answer.split(/(?<=[.!?])\s+|\n+/u).filter(Boolean);
const anySentence = (answer: string, test: (sentence: string) => boolean) => sentences(answer).some(test);
/** A named decision such as "Mensah v Mensah", "Republic v. High Court; Ex parte X" or a neutral/law-report citation. */
const namedCase = /\b[A-Z][\p{L}'.-]+(?:\s+[A-Z][\p{L}'.-]+)*\s+v(?:s)?\.?\s+[A-Z][\p{L}'.-]+|\[(?:19|20)\d{2}\]\s*\d*\s*[A-Z]|\bGHASC\b|\bJ[1-7]\/\d+\/(?:19|20)\d{2}\b/u;
const caseRetrievalFailureStated = /(could not|cannot|can't|was not able to|unable to) (retrieve|find|locate|confirm|verify)[^.]{0,60}(case|decision|judgment|ruling)/iu;
const unverifiedHedge = /(could not|cannot|can't|unable to|not able to) (verify|confirm|find|locate|retrieve)|(retrieved|available) (passages|sources|library)[^.]{0,60}(do not|does not|don't)/iu;
const conditional = /\b(if|unless|depends|depending|whether|until|only when|only if)\b/iu;

const mentionsSection = (section: number) => new RegExp(String.raw`\b(?:section|s\.)\s*${section}\b`, "iu");

export const COMPARISON_REGRESSION_SCENARIOS: readonly LegalRegressionScenario[] = [
  {
    id: "comparison-q1-maternity-leave",
    jurisdiction: "Ghana",
    title: "Maternity leave keeps 12 weeks, full pay and the Labour Act source",
    turns: [comparisonTurn("I work full-time for a private company in Accra. My manager says I can take only six weeks off after giving birth and that I might lose my job if I need longer. What are my rights and where can I complain?")],
    checks: [
      { id: "twelve-weeks", description: "States the 12-week minimum.",
        run: a => /\b(12|twelve)\s*weeks\b/iu.test(a) ? null : "Does not state the 12-week minimum." },
      { id: "full-pay", description: "States that maternity leave is on full pay.",
        run: a => /full (pay|remuneration|wages|salary)/iu.test(a) ? null : "Does not state full pay." },
      { id: "labour-act-s57", description: "Cites Labour Act section 57.",
        run: a => mentionsSection(57).test(a) ? null : "Does not cite section 57 of the Labour Act." },
    ],
  },
  {
    id: "comparison-q2-rent-advance",
    jurisdiction: "Ghana",
    title: "Rent advance keeps the six-month limit and does not volunteer an unreconciled penalty",
    turns: [comparisonTurn("I'm renting a room in Kumasi for a two-year term. The landlord will give me the keys only if I pay all two years' rent upfront. Is that allowed, and what can I do?")],
    checks: [
      { id: "six-month-limit", description: "States the six-month advance limit.",
        run: a => /\b(6|six)[ -]months?\b/iu.test(a) ? null : "Does not state the six-month advance limit." },
      { id: "no-unreconciled-penalty", description: "A precise penalty figure is flagged as differing between official texts or unconfirmed.",
        run: a => !anySentence(a, s => /(penalty|fine|imprison)/iu.test(s) && /(\d|penalty units)/u.test(s))
          || /(versions?|texts?) [^.]{0,60}(differ|conflict|inconsistent)|(could not|cannot) (confirm|reconcile)[^.]{0,60}(penalty|fine)/iu.test(a)
          ? null : "States a precise penalty without noting that official texts differ." },
    ],
  },
  {
    id: "comparison-q3-lockout",
    jurisdiction: "Ghana",
    title: "Lockout answer requires court process before recovery of possession",
    turns: [comparisonTurn("I'm two months behind on rent. My landlord says he will change the locks and put my things outside tomorrow, without going to court. Can he do that? What should I do now?")],
    checks: [
      { id: "court-required", description: "Explains that the landlord needs a court order or proceedings.",
        run: a => /court (order|process|proceedings|action)|order of (the )?court|apply to (the )?(court|rent)/iu.test(a) ? null : "Does not explain that court process is required." },
    ],
  },
  {
    id: "comparison-q4-marital-property-cases",
    jurisdiction: "Ghana",
    title: "Divorce property answer names Ghanaian decisions and keeps section 38's conditions",
    turns: [comparisonTurn("My husband says I will get nothing from the house if we divorce because it is in his name and I did not pay for it. I spent years caring for our children and supervising its construction. Have Ghana's courts dealt with situations like this, and does marriage mean everything must be split equally?")],
    checks: [
      { id: "names-decision", description: "Names at least one Ghanaian decision (the acceptance bar from the comparison).",
        run: a => namedCase.test(a) ? null : caseRetrievalFailureStated.test(a)
          ? "States that case retrieval failed but names no decision." : "Does not name a Ghanaian decision." },
      { id: "s38-conditions", description: "Any reliance on Land Act section 38 keeps 'jointly acquired' and 'for valuable consideration'.",
        run: a => !mentionsSection(38).test(a) || (/jointly acquired/iu.test(a) && /valuable consideration/iu.test(a))
          ? null : "Relies on section 38 without 'jointly acquired' and 'for valuable consideration'." },
      { id: "no-automatic-equal-split", description: "Does not promise an automatic equal split of everything.",
        run: a => anySentence(a, s => /(automatically|always|everything)[^.]{0,60}(split|divided|shared) equally/iu.test(s) && !/\b(not|no|never|doesn't|does not)\b/iu.test(s))
          ? "Promises an automatic equal split." : null },
    ],
  },
  {
    id: "comparison-q5-maintenance",
    jurisdiction: "Ghana",
    title: "Maintenance answer keeps the Children's Act duty, Family Tribunal and testing power",
    turns: [comparisonTurn("My child's father says he does not have to support our eight-year-old because we were never married. Is that right, and how can I seek support?")],
    checks: [
      { id: "childrens-act", description: "Cites the Children's Act.", run: a => /children'?s act/iu.test(a) ? null : "Does not cite the Children's Act." },
      { id: "family-tribunal", description: "Names the Family Tribunal.", run: a => /family tribunal/iu.test(a) ? null : "Does not name the Family Tribunal." },
      { id: "testing-power", description: "Mentions the tribunal's power to order medical or parentage testing.",
        run: a => /(medical|paternity|parentage|DNA|blood) (test|testing|examination)/iu.test(a) ? null : "Omits the medical-testing power." },
    ],
  },
  {
    id: "comparison-q6-marketing-texts",
    jurisdiction: "Ghana",
    title: "Marketing texts answer keeps the written-consent rule and the regulator",
    turns: [comparisonTurn("A shop collected my phone number for a delivery and now sends me advertising texts. I never agreed to advertising and have asked it to stop. What rights do I have, and who can I complain to?")],
    checks: [
      { id: "written-consent", description: "States the prior written-consent rule for direct marketing.",
        run: a => /(written consent|consent in writing|prior (written )?consent)/iu.test(a) ? null : "Does not state the written-consent rule." },
      { id: "regulator", description: "Names the Data Protection Commission.",
        run: a => /data protection commission/iu.test(a) ? null : "Does not name the Data Protection Commission." },
    ],
  },
  {
    id: "comparison-q7-recording-evidence",
    jurisdiction: "Ghana",
    title: "Secret recording answer names decisions and describes discretionary exclusion",
    turns: [comparisonTurn("I secretly recorded a phone call with someone who owes me money. Can I use the recording in court just because I was part of the conversation? Have Ghana's courts ruled on this?")],
    checks: [
      { id: "names-decision", description: "Names at least one Ghanaian decision.",
        run: a => namedCase.test(a) ? null : "Does not name a Ghanaian decision." },
      { id: "discretion", description: "Explains that admission is at the court's discretion.",
        run: a => /discretion/iu.test(a) ? null : "Does not explain the court's discretion." },
      { id: "no-automatic-rule", description: "Does not claim the recording is automatically admissible or always excluded.",
        run: a => anySentence(a, s => /(automatically|always) (admissible|excluded|inadmissible)/iu.test(s) && !/\b(not|no|never)\b/iu.test(s))
          ? "Claims an automatic admissibility rule." : null },
    ],
  },
  {
    id: "comparison-q8-company-debt",
    jurisdiction: "Ghana",
    title: "Company debt answer keeps separate personality and the unpaid-share qualification",
    turns: [comparisonTurn("I own all the shares in a registered limited-liability company. It owes a supplier money, but I never personally guaranteed the debt. Can the supplier automatically take my personal house, or does it matter that the business is a company?")],
    checks: [
      { id: "separate-personality", description: "Explains the company's separate legal personality.",
        run: a => /separate (legal )?(person|personality|entity)|distinct legal (person|entity)/iu.test(a) ? null : "Does not explain separate legal personality." },
      { id: "unpaid-shares", description: "Mentions the unpaid-share qualification.",
        run: a => /unpaid|not (fully )?paid/iu.test(a) ? null : "Omits the unpaid-share qualification." },
    ],
  },
  {
    id: "comparison-q9-dollar-rent",
    jurisdiction: "Ghana",
    title: "Dollar rent answer reconciles current Bank of Ghana pricing rules",
    turns: [comparisonTurn("I am a Ghanaian living in Ghana. A landlord in Accra says my rent must be quoted and paid in US dollars. Is that permitted, or can I insist on cedis?")],
    checks: [
      { id: "current-pricing-rules", description: "Cites Bank of Ghana notices or the Foreign Exchange Act on quoting and pricing.",
        run: a => /bank of ghana|foreign exchange act|act 723/iu.test(a) ? null : "Does not cite current Bank of Ghana pricing rules." },
      { id: "no-dollar-clause-advice", description: "Does not recommend dollar-reference wording.",
        run: a => anySentence(a, s => /(include|add|use|draft|insert)[^.]{0,40}(clause|wording|term)[^.]{0,60}(dollar|USD|US\$)/iu.test(s) && !/\b(not|avoid|never|don't)\b/iu.test(s))
          ? "Recommends dollar-reference clause wording." : null },
    ],
  },
  {
    id: "comparison-q10-e-levy",
    jurisdiction: "Ghana",
    title: "E-Levy answer reports the 2025 repeal and separates provider fees",
    turns: [comparisonTurn("I'm sending money by mobile money today. Does the government still charge the electronic transfer levy, and are all transfer charges the same thing as that levy?")],
    checks: [
      { id: "reports-repeal", description: "Reports that the E-Levy was repealed.",
        run: a => /repeal/iu.test(a) ? null : "Does not report the repeal." },
      { id: "provider-fees", description: "Distinguishes provider or network fees from the levy.",
        run: a => /(provider|network|operator|telco|service|transaction)[ -](fees?|charges?)/iu.test(a) ? null : "Does not distinguish provider fees." },
    ],
  },
  {
    id: "comparison-q11-invented-tenancy-act",
    jurisdiction: "Ghana",
    title: "Invented Act answer avoids absence-as-proof and keeps section 32's pre-commencement limit",
    turns: [comparisonTurn("Someone told me there is a 'Ghana Online Tenancy Protection Act 2025' that gives every tenant an automatic three-month rent refund whenever a landlord requests more than six months upfront. Is that law real, and am I guaranteed that refund?")],
    checks: [
      { id: "no-invented-refund", description: "Does not confirm the invented automatic refund.",
        run: a => anySentence(a, s => /(you are|you're) (guaranteed|entitled to)[^.]{0,40}(three|3)[- ]month/iu.test(s) && !/\b(not|no)\b/iu.test(s))
          ? "Confirms the invented refund." : null },
      { id: "no-absence-as-proof", description: "Does not state the Act does not exist without saying it could not be verified.",
        run: a => /(does not|doesn't) exist|is not a real|isn't a real|no such (act|law)/iu.test(a) && !unverifiedHedge.test(a)
          ? "Treats absence from the library as proof the law does not exist." : null },
      { id: "s32-pre-commencement", description: "Any reliance on Rent Act section 32 keeps its pre-commencement condition.",
        run: a => !mentionsSection(32).test(a) || /(before|prior to) (the )?(commencement|coming into force|start)|commencement of (the|this) act|pre-commencement/iu.test(a)
          ? null : "Applies section 32 without its pre-commencement condition." },
    ],
  },
  {
    id: "comparison-q12-inherited-land",
    jurisdiction: "Ghana",
    title: "Inherited land answer stays conditional and separates beneficiary and representative roles",
    turns: [comparisonTurn("My father has died and left some land. Can I sell it?")],
    checks: [
      { id: "no-adverse-capacity-finding", description: "Does not tell the user they lack title or capacity without a condition.",
        run: a => anySentence(a, s => /you (cannot|can't|can not|do not have|don't have|lack)[^.]{0,40}(sell|title|capacity|right)/iu.test(s) && !conditional.test(s))
          ? "States an unconditional adverse capacity finding." : null },
      { id: "representative-role", description: "Distinguishes an administrator or executor sale.",
        run: a => /administrator|executor|personal representative/iu.test(a) ? null : "Does not mention the estate representative's role." },
      { id: "grant-status", description: "Raises will, probate or letters of administration status.",
        run: a => /probate|letters of administration|grant|\bwill\b/iu.test(a) ? null : "Does not raise grant or will status." },
    ],
  },
];

export const ALL_LEGAL_REGRESSION_SCENARIOS: readonly LegalRegressionScenario[] = [
  ...LEGAL_REGRESSION_SCENARIOS, ...COMPARISON_REGRESSION_SCENARIOS,
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
