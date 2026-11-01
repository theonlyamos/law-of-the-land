import { expect, test, type Page } from "@playwright/test";

type SourceInput = {
  sourceClass: string; sourceUrl: string; verificationNotes: string; corroboratingUrls: string[];
  completeOriginal: boolean; citationChecked: boolean; laterTreatmentChecked: boolean;
};
type ReviewLedger = {
  approvals: Array<{ sourceVerification: SourceInput; checklistAnswers: Record<string, boolean>; evaluationRunId: string }>;
  corrections: Array<{ assessment: string; sourceVerification: SourceInput }>;
  decisions: unknown[]; history: Array<{ verificationNotes: string }>; status: string;
};
async function ledger(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("batch-import-fixture-review") ?? "null") as ReviewLedger | null);
}
async function reviewChecks(page: Page, authenticity: string) {
  for (const label of ["Complete original verified", "Case citation checked against the source", "Later treatment checked and recorded in the notes", authenticity, "Metadata is accurate", "Original text reviewed", "Citations verified", "Search evaluation passed"]) {
    await page.getByRole("checkbox", { name: label, exact: true }).check();
  }
  await page.getByLabel("Evaluation run ID", { exact: true }).fill("browser-fixture-evaluation");
  await page.getByLabel("Decision reason", { exact: true }).fill("Fixture original, metadata and search evidence reviewed.");
}
async function correctionEvidence(page: Page, assessment: "verified" | "unresolved") {
  await page.getByRole("button", { name: "Record source correction", exact: true }).click();
  await page.getByRole("combobox", { name: "Correction assessment", exact: true }).selectOption(assessment);
  await page.getByRole("combobox", { name: "Source classification", exact: true }).selectOption("corroborated_reproduction");
  await page.getByLabel("Verification notes", { exact: true }).fill(assessment === "verified"
    ? "New independent source comparison confirms the complete court text and citation; later treatment was checked."
    : "The reproduction is missing pages and later treatment remains unresolved; fresh review is required.");
  if (assessment === "verified") {
    await page.getByLabel("Corroborating URLs (one per line)", { exact: true }).fill("https://judicial.gov.gh/decisions/comparison.pdf");
    for (const label of ["Complete original verified", "Case citation checked against the source", "Later treatment checked and recorded in the notes"]) await page.getByRole("checkbox", { name: label, exact: true }).check();
  }
  await page.getByLabel("Correction reason", { exact: true }).fill("Correct the source classification with the recorded evidence.");
}

test("source review approves an official judgment only after explicit evidence and all assertions", async ({ page }) => {
  await page.goto("/?review=1");
  await expect(page.getByRole("combobox", { name: "Source classification", exact: true })).toHaveValue("");
  await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Source classification", exact: true }).selectOption("official_hosted");
  await expect(page.getByLabel("Actual source URL", { exact: true })).toHaveValue("https://judicial.gov.gh/decisions/fixture.pdf");
  await expect(page.getByLabel("Actual source URL", { exact: true })).toHaveAttribute("readonly", "");
  await page.getByLabel("Verification notes", { exact: true }).fill("Court-hosted complete original compared with its citation; subsequent treatment checked for this fixture.");
  await reviewChecks(page, "Official source authenticated");
  await page.getByRole("button", { name: "Approve version", exact: true }).click();
  await expect(page.getByRole("button", { name: "Publish version", exact: true })).toBeVisible();
  const result = (await ledger(page))!;
  expect(result.approvals).toHaveLength(1);
  expect(result.approvals[0].sourceVerification).toMatchObject({ sourceClass: "official_hosted", sourceUrl: "https://judicial.gov.gh/decisions/fixture.pdf", completeOriginal: true, citationChecked: true, laterTreatmentChecked: true });
  expect(Object.values(result.approvals[0].checklistAnswers)).toEqual([true, true, true, true, true]);
  expect(result.approvals[0].evaluationRunId).toBe("browser-fixture-evaluation");
});

test("source review corroborates a reproduction independently without calling it official", async ({ page }) => {
  await page.goto("/?review=1&reviewSource=reproduction");
  await page.getByRole("combobox", { name: "Source classification", exact: true }).selectOption("corroborated_reproduction");
  await expect(page.getByText("Official source authenticated", { exact: true })).toHaveCount(0);
  await page.getByLabel("Verification notes", { exact: true }).fill("The law-firm reproduction was compared against independent court evidence, including completeness, citation and later treatment.");
  await page.getByLabel("Corroborating URLs (one per line)", { exact: true }).fill("https://example-lawfirm.test/another-copy.pdf");
  await reviewChecks(page, "Reproduction authenticity independently corroborated");
  await page.getByRole("button", { name: "Approve version", exact: true }).click();
  await expect(page.getByText(/needs at least one independent corroborating source/)).toBeVisible();
  expect(await ledger(page)).toBeNull();
  await page.getByLabel("Corroborating URLs (one per line)", { exact: true }).fill("https://judicial.gov.gh/decisions/comparison.pdf");
  await page.getByRole("button", { name: "Approve version", exact: true }).click();
  await expect(page.getByRole("button", { name: "Publish version", exact: true })).toBeVisible();
  const result = (await ledger(page))!;
  expect(result.approvals).toHaveLength(1);
  expect(result.approvals[0].sourceVerification).toMatchObject({ sourceClass: "corroborated_reproduction", sourceUrl: "https://example-lawfirm.test/decisions/fixture.pdf", corroboratingUrls: ["https://judicial.gov.gh/decisions/comparison.pdf"] });
});

test("source review sends no approval when source classification or complete evidence is absent", async ({ page }) => {
  await page.goto("/?review=1");
  await page.getByRole("button", { name: "Approve version", exact: true }).click();
  expect(await ledger(page)).toBeNull();
  await page.getByRole("combobox", { name: "Source classification", exact: true }).selectOption("official_hosted");
  await page.getByLabel("Verification notes", { exact: true }).fill("The available original needs a complete-text and later-treatment check before approval.");
  for (const label of ["Official source authenticated", "Metadata is accurate", "Original text reviewed", "Citations verified", "Search evaluation passed"]) await page.getByRole("checkbox", { name: label, exact: true }).check();
  await page.getByLabel("Evaluation run ID", { exact: true }).fill("browser-fixture-evaluation");
  await page.getByLabel("Decision reason", { exact: true }).fill("Source evidence remains incomplete.");
  await page.getByRole("button", { name: "Approve version", exact: true }).click();
  await expect(page.getByText(/Verify the complete original, citation, and later treatment/)).toBeVisible();
  expect(await ledger(page)).toBeNull();
});

test("source review appends a verified correction and retains earlier decisions and assertions", async ({ page }) => {
  await page.goto("/?review=1&reviewSource=reproduction&reviewStatus=approved");
  await expect(page.getByText("Earlier review decision retained verbatim.", { exact: true })).toBeVisible();
  await correctionEvidence(page, "verified");
  await page.getByRole("button", { name: "Append source correction", exact: true }).click();
  await expect(page.getByText(/Source correction recorded. Prior assertions and audit records are preserved/)).toBeVisible();
  await expect(page.getByText("Earlier review decision retained verbatim.", { exact: true })).toBeVisible();
  await expect(page.getByText("Earlier source assertion retained verbatim.", { exact: true })).toBeVisible();
  const result = (await ledger(page))!;
  expect(result.approvals).toHaveLength(0);
  expect(result.corrections).toHaveLength(1);
  expect(result.corrections[0].assessment).toBe("verified");
  expect(result.history).toHaveLength(2);
  expect(result.decisions).toHaveLength(1);
});

test("source review records unresolved approved evidence with the unresolved assessment", async ({ page }) => {
  await page.goto("/?review=1&reviewSource=reproduction&reviewStatus=approved");
  await correctionEvidence(page, "unresolved");
  await expect(page.getByText(/withdraws the current approval and returns this version for fresh review/)).toBeVisible();
  await page.getByRole("button", { name: "Append source correction", exact: true }).click();
  await expect(page.getByRole("button", { name: "Approve version", exact: true })).toBeVisible();
  const result = (await ledger(page))!;
  expect(result.corrections).toHaveLength(1);
  expect(result.corrections[0]).toMatchObject({ assessment: "unresolved", sourceVerification: { sourceClass: "corroborated_reproduction", completeOriginal: false, citationChecked: false, laterTreatmentChecked: false } });
  expect(result.status).toBe("ready_for_review");
  expect(result.approvals).toHaveLength(0);
  expect(result.history).toHaveLength(2);
  expect(result.decisions).toHaveLength(1);
  await expect(page.getByText("Earlier review decision retained verbatim.", { exact: true })).toBeVisible();
  await expect(page.getByText("Earlier source assertion retained verbatim.", { exact: true })).toBeVisible();
});
