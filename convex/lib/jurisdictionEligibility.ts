import type { Doc } from "../_generated/dataModel";
import { isGeminiFileSearchStoreName } from "./geminiFileSearchNames";

export function isPublicJurisdictionEligible(
  jurisdiction: Pick<
    Doc<"jurisdictions">,
    "status" | "providerSyncState" | "geminiFileSearchStoreName"
  >,
): boolean {
  return (
    jurisdiction.status === "enabled" &&
    jurisdiction.providerSyncState === "synced" &&
    jurisdiction.geminiFileSearchStoreName !== undefined &&
    isGeminiFileSearchStoreName(jurisdiction.geminiFileSearchStoreName)
  );
}
