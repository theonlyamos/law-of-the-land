import { afterEach, expect, it, vi } from "vitest";
import { createWidgetServiceProof, verifyWidgetServiceProof, uploadProofBytes } from "./widgetProof";
afterEach(() => vi.unstubAllEnvs());
it("binds service proofs to exact operation, bytes, time and upload owner", async () => {
  vi.stubEnv("EMBED_SERVICE_SECRET", "test-only-service-secret-".repeat(3));
  const actor = { userId: "manager", sessionId: "assured-session" }, file = { resourceId: "resource-a", storageId: "original", filename: "policy.txt", mimeType: "text/plain", byteSize: 4, sha256: "a".repeat(64), sourceUrl: "https://example.org", effectiveAt: "2026-01-01" };
  const now = Date.now(), bytes = uploadProofBytes(actor, file), signature = await createWidgetServiceProof("upload", now, bytes);
  expect(await verifyWidgetServiceProof("upload", now, bytes, signature)).toBe(true);
  expect(await verifyWidgetServiceProof("finish", now, bytes, signature)).toBe(false);
  expect(await verifyWidgetServiceProof("upload", now - 61000, bytes, signature)).toBe(false);
  expect(await verifyWidgetServiceProof("upload", now, uploadProofBytes({ ...actor, userId: "other" }, file), signature)).toBe(false);
  expect(await verifyWidgetServiceProof("upload", now, uploadProofBytes(actor, { ...file, resourceId: "resource-b" }), signature)).toBe(false);
});
