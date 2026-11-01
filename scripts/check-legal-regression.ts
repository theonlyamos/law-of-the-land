// Scores answers copied from the deployed app against the legal regression scenarios.
// Usage: bun scripts/check-legal-regression.ts answers.json
// answers.json maps a scenario id to the answer text for its last turn, for example
// { "comparison-q1-maternity-leave": "## Direct answer\n..." }. Scenarios without an
// answer are listed as not run, so a partial run is never reported as a pass.
import { readFileSync } from "node:fs";
import { ALL_LEGAL_REGRESSION_SCENARIOS, checkLegalRegression } from "../shared/legal-regression-scenarios";

const path = process.argv[2];
if (!path) {
  console.error("Usage: bun scripts/check-legal-regression.ts answers.json");
  process.exit(2);
}
const answers: Record<string, unknown> = JSON.parse(readFileSync(path, "utf8"));
let passed = 0, failed = 0, notRun = 0;
for (const scenario of ALL_LEGAL_REGRESSION_SCENARIOS) {
  const answer = answers[scenario.id];
  if (typeof answer !== "string") {
    notRun++;
    console.log(`-    ${scenario.id} (not run)`);
    continue;
  }
  const { failures } = checkLegalRegression(scenario, answer);
  if (failures.length) {
    failed++;
    console.log(`FAIL ${scenario.id}\n${failures.map(failure => `       ${failure}`).join("\n")}`);
  } else {
    passed++;
    console.log(`PASS ${scenario.id}`);
  }
}
const unknown = Object.keys(answers).filter(id => !ALL_LEGAL_REGRESSION_SCENARIOS.some(item => item.id === id));
if (unknown.length) console.log(`Unknown scenario ids ignored: ${unknown.join(", ")}`);
console.log(`\n${passed} passed, ${failed} failed, ${notRun} not run`);
process.exit(failed ? 1 : 0);
