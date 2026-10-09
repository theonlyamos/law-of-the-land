// @vitest-environment node
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { createReservationLedger, CAMPAIGN } from "./ledger";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep) || !directory.includes("split-process-test-")) throw new Error("unsafe cleanup");
    await rm(directory, { recursive: true, force: true });
  }
});
const require = createRequire(import.meta.url);
const executeFile = promisify(execFile);
async function runChild(directory: string) {
  const environment: NodeJS.ProcessEnv = { NODE_ENV: "test" };
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "PATH", "NODE_OPTIONS", "NODE_ENV"])
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  environment.TS_NODE_SKIP_PROJECT = "1";
  environment.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node", ignoreDeprecations: "6.0", esModuleInterop: true, resolveJsonModule: true });
  const script = `const {createReservationLedger}=require(process.argv[1]);
    const ledger=createReservationLedger({directory:process.argv[2],campaign:'split-verifier-offline-v1',caseId:'nine-month-control'});
    (async()=>{const accepted=await ledger.reserveCase(); const stage=await ledger.reserveStage('inventory'); process.stdout.write(JSON.stringify({accepted,stage}));})().catch(()=>process.exit(2));`;
  const { stdout, stderr } = await executeFile(process.execPath, ["-r", require.resolve("ts-node/register/transpile-only"), "-e", script,
    resolve("src/lib/source-verification/split-verification/ledger.ts"), directory], { env: environment, windowsHide: true, timeout: 15000 });
  expect(stderr).toBe("");
  return JSON.parse(stdout) as { accepted: boolean; stage: boolean };
}

it("native processes race once and a restarted process cannot replace a consumed case/stage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "split-process-test-")); directories.push(directory);
  const raced = await Promise.all([runChild(directory), runChild(directory)]);
  expect(raced.filter(r => r.accepted && r.stage)).toHaveLength(1);
  expect(raced.filter(r => !r.accepted && !r.stage)).toHaveLength(1);
  expect(await runChild(directory)).toEqual({ accepted: false, stage: false });
}, 30000);

it("empty or truncated reservation files from ambiguous interruption remain consumed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "split-process-test-")); directories.push(directory);
  const caseDirectory = join(directory, CAMPAIGN, "nine-month-control"); await mkdir(caseDirectory, { recursive: true });
  const interrupted = await open(join(caseDirectory, "case.reserved"), "wx"); await interrupted.sync(); await interrupted.close();
  expect(await createReservationLedger({ directory, campaign: CAMPAIGN, caseId: "nine-month-control" }).reserveCase()).toBe(false);
  const ledger = createReservationLedger({ directory, campaign: CAMPAIGN, caseId: "lifecycle" });
  expect(await ledger.reserveCase()).toBe(true);
  const partial = await open(join(directory, CAMPAIGN, "lifecycle", "inventory.reserved"), "wx");
  await partial.writeFile('{"version":'); await partial.sync(); await partial.close();
  expect(await ledger.reserveStage("inventory")).toBe(false);
});
