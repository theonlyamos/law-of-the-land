import { createTelemetryServiceProof, verifyTelemetryServiceProof } from "./telemetryProof";

type AttachmentOperation = "resolve" | "file";

export async function createChatAttachmentProof(operation: AttachmentOperation, body: string, issuedAt: number): Promise<string> {
  return createTelemetryServiceProof(["chat-attachment-v1", operation, body, issuedAt]);
}

export async function verifyChatAttachmentProof(operation: AttachmentOperation, body: string, issuedAt: number, proof: string): Promise<boolean> {
  return Number.isSafeInteger(issuedAt) && Math.abs(Date.now() - issuedAt) <= 60_000
    && await verifyTelemetryServiceProof(proof, ["chat-attachment-v1", operation, body, issuedAt]);
}
