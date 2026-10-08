import { mkdir, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { STAGES, type Stage } from "./contracts";

export const CAMPAIGN = "split-verifier-offline-v1" as const;
export const CASE_IDS = ["nine-month-control", "missing-consent", "unknown-exclusion", "positive-application", "branch-exclusion", "eight-month-boundary", "night-work-scope", "shared-qualifier", "later-disclaimer", "hostile-data", "limits", "lifecycle"] as const;
export type ReservationLedger = Readonly<{ reserveCase(): Promise<boolean>; reserveStage(stage: Stage): Promise<boolean> }>;

/** Trusted local operator/test configuration only. No request or model chooses
 * paths/cases; no replacement run ID and no refund/remove API. Keep the namespace
 * on durable local storage, never a rotating temp path for a real campaign. */
export function createReservationLedger(configuration: Readonly<{ directory: string; campaign: typeof CAMPAIGN; caseId: typeof CASE_IDS[number] }>): ReservationLedger {
  if (configuration.campaign !== CAMPAIGN || !CASE_IDS.includes(configuration.caseId) || !isAbsolute(configuration.directory))
    throw new Error("invalid experimental reservation configuration");
  const directory = join(configuration.directory, CAMPAIGN, configuration.caseId);
  let ownsCase = false, caseAttempted = false;
  const attemptedStages = new Set<Stage>();
  async function consume(name: "case" | Stage): Promise<boolean> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await mkdir(directory, { recursive: true });
      // Existence is consumption even if writing/sync/close fails or the process
      // stops immediately after creation. Never overwrite or unlink an attempt.
      handle = await open(join(directory, `${name}.reserved`), "wx", 0o600);
      await handle.writeFile('{"version":1,"consumed":true}\n', "utf8");
      await handle.sync();
      await handle.close(); handle = undefined;
      return true;
    } catch { return false; }
    finally { if (handle) { try { await handle.close(); } catch { /* already consumed */ } } }
  }
  return Object.freeze({
    async reserveCase() {
      if (caseAttempted) return false;
      caseAttempted = true;
      ownsCase = await consume("case");
      return ownsCase;
    },
    async reserveStage(stage: Stage) {
      if (!ownsCase || !STAGES.includes(stage) || attemptedStages.has(stage)) return false;
      attemptedStages.add(stage);
      return consume(stage);
    },
  });
}
