import { createTelemetryServiceProof, verifyTelemetryServiceProof } from "./telemetryProof";

export async function createAdminFileProof(versionId: string, issuedAt: number): Promise<string> {
  return createTelemetryServiceProof(["admin-file-v1", versionId, issuedAt]);
}

export async function verifyAdminFileProof(versionId: string, issuedAt: number, proof: string): Promise<boolean> {
  return Number.isSafeInteger(issuedAt) && Math.abs(Date.now() - issuedAt) <= 60_000
    && await verifyTelemetryServiceProof(proof, ["admin-file-v1", versionId, issuedAt]);
}
