import { v } from "convex/values";
import { citationFileProofParts } from "../../shared/citation-source-preview";
import { verifyTelemetryServiceProof } from "./telemetryProof";

export const citationFileProofValidators = { expiresAt: v.optional(v.number()), serviceProof: v.optional(v.string()) };
export async function validCitationFileProof(args: {
  externalId: string; messageId: string; citationIndex: number; expiresAt?: number; serviceProof?: string;
}): Promise<boolean> {
  if (typeof args.expiresAt !== "number" || !Number.isSafeInteger(args.expiresAt) || !args.serviceProof
    || args.expiresAt <= Date.now() || args.expiresAt > Date.now() + 60_000) return false;
  try { return await verifyTelemetryServiceProof(args.serviceProof, citationFileProofParts({ ...args, expiresAt: args.expiresAt })); }
  catch { return false; }
}
