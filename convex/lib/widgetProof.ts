import { createTelemetryServiceProofForSecret, hashOpaqueTelemetryValue } from "./telemetryProof";

export async function createWidgetServiceProof(operation: string, issuedAt: number, bodyBytes: Uint8Array): Promise<string> {
  const secret = process.env.EMBED_SERVICE_SECRET;
  if (!secret || secret.length < 32) throw new Error("Chat widget is not configured");
  return createTelemetryServiceProofForSecret(secret, ["widget-v1", operation, issuedAt, await hashOpaqueTelemetryValue(new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes))]);
}
export async function verifyWidgetServiceProof(operation: string, issuedAt: number, bodyBytes: Uint8Array, signature: string): Promise<boolean> {
  if (!Number.isSafeInteger(issuedAt) || Math.abs(Date.now() - issuedAt) > 60_000 || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
  const expected = await createWidgetServiceProof(operation, issuedAt, bodyBytes);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return difference === 0;
}
export function uploadProofBytes(actor: { userId: string; sessionId: string }, file: {
  resourceId: string; storageId: string; filename: string; mimeType: string; byteSize: number; sha256: string; sourceUrl: string; effectiveAt: string;
}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([actor.userId, actor.sessionId, file.resourceId, file.storageId, file.filename, file.mimeType, file.byteSize, file.sha256, file.sourceUrl, file.effectiveAt]));
}
