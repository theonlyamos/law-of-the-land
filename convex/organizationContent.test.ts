import { makeFunctionReference } from "convex/server";
import { expect, it } from "vitest";
import { createWidgetBackend, seedPublicWidget, addOrganizationMember } from "./widgetTestHelpers.fixture";

it("allows only the current owner to review their own submission", async () => {
  const t = createWidgetBackend(), f = await seedPublicWidget(t);
  const owner = await addOrganizationMember(t, f.organizationId, "manager");
  await t.run(async ctx => {
    await ctx.db.patch(f.organizationId, { ownerUserId: owner.userId });
    await ctx.db.patch(f.resourceId, { activeVersionId: undefined });
    await ctx.db.patch(f.versionId, { status: "ready_for_review", submittedBy: owner.userId });
  });
  const approve = makeFunctionReference<"mutation">("organizationContent:approveVersion");
  const input = { versionId: f.versionId, reason: "Reviewed source and citations", evaluationRunId: "owner-evaluation", idempotencyKey: "owner_review_001", checklistAnswers: { sourceAuthentic: true, metadataAccurate: true, extractionReviewed: true, citationsVerified: true, evaluationPassed: true } };
  await expect(owner.client.mutation(approve, { ...input, checklistAnswers: { ...input.checklistAnswers, sourceAuthentic: false } })).rejects.toThrow("DOCUMENT_CHECKLIST_INCOMPLETE");
  await owner.client.mutation(approve, input);
  expect(await t.run(ctx => ctx.db.get(f.versionId))).toMatchObject({ status: "approved", reviewedBy: owner.userId, submittedBy: owner.userId });
  await t.run(async ctx => {
    await ctx.db.patch(f.organizationId, { ownerUserId: undefined });
    await ctx.db.patch(owner.membershipId, { role: "reviewer" });
    await ctx.db.patch(f.versionId, { status: "ready_for_review" });
  });
  await expect(owner.client.mutation(approve, { ...input, idempotencyKey: "reviewer_self_001" })).rejects.toThrow("different reviewer");
});

it("rejects cross-organization resource writes and forged upload receipts", async () => {
  const t = createWidgetBackend(), a = await seedPublicWidget(t), b = await seedPublicWidget(t);
  const manager = await addOrganizationMember(t, a.organizationId, "manager");
  await expect(manager.client.mutation(makeFunctionReference<"mutation">("organizationContent:archiveResource"), { id: b.resourceId, reason: "Archive old policy" })).rejects.toThrow("ORGANIZATION_ACCESS_DENIED");
  const storageId = await t.run(ctx => ctx.storage.store(new Blob(["fixture policy"])));
  await expect(manager.client.mutation(makeFunctionReference<"mutation">("organizationContent:finalizeUpload"), { resourceId: a.resourceId, storageId, filename: "policy.txt", mimeType: "text/plain", byteSize: 14, sha256: "0".repeat(64), sourceUrl: "https://greenfield.example/policy", effectiveAt: "2026-09-11", issuedAt: Date.now(), signature: "forged" })).rejects.toThrow("UPLOAD_PROOF_INVALID");
});

it("scopes password verification to the current organization role and target", async () => {
  const t = createWidgetBackend(), own = await seedPublicWidget(t), other = await seedPublicWidget(t);
  const manager = await addOrganizationMember(t, own.organizationId, "manager");
  const proof = makeFunctionReference<"mutation">("admin/users:recordAdminStepUpProof");
  const input = { actorId: manager.userId, sessionId: manager.sessionId, action: "organization_visibility", targetId: own.jurisdictionId, idempotencyKey: "visibility_test_123" };
  await t.mutation(proof, input);
  await expect(t.mutation(proof, { ...input, targetId: other.jurisdictionId })).rejects.toThrow("ADMIN_STEP_UP_SCOPE_INVALID");
  await expect(t.mutation(proof, { ...input, action: "document_publish", targetId: own.versionId })).rejects.toThrow("ADMIN_STEP_UP_SCOPE_INVALID");
  await t.run(ctx => ctx.db.patch(manager.membershipId, { status: "inactive" }));
  await expect(manager.client.mutation(makeFunctionReference<"mutation">("organizations:setVisibility"), { organizationId: own.organizationId, visibility: "members", confirmation: `PRIVATE ${own.jurisdictionId}`, idempotencyKey: input.idempotencyKey })).rejects.toThrow("ORGANIZATION_ACCESS_DENIED");
});
import { createWidgetServiceProof, uploadProofBytes } from "./lib/widgetProof";
import { vi } from "vitest";
it("finalizes only the verified original and permits an exact retry", async () => {
  vi.stubEnv("EMBED_SERVICE_SECRET", "fixture-upload-secret-".repeat(3));
  vi.stubEnv("ADMIN_MAX_DOCUMENT_BYTES", "4194304");
  try {
    const t = createWidgetBackend(), f = await seedPublicWidget(t), manager = await addOrganizationMember(t, f.organizationId, "manager");
    const bytes = new TextEncoder().encode("new policy");
    const storageId = await t.run(ctx => ctx.storage.store(new Blob([bytes], { type: "text/plain" })));
    const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
    const input = { resourceId: f.resourceId, storageId, filename: "new-policy.txt", mimeType: "text/plain", byteSize: bytes.length, sha256, sourceUrl: "https://greenfield.example/policy", effectiveAt: "2026-09-11" };
    const issuedAt = Date.now(), signature = await createWidgetServiceProof("organization-upload-finalize", issuedAt, uploadProofBytes(manager, input));
    const ref = makeFunctionReference<"mutation">("organizationContent:finalizeUpload");
    const versionId = await manager.client.mutation(ref, { ...input, issuedAt, signature });
    expect(await manager.client.mutation(ref, { ...input, issuedAt, signature })).toBe(versionId);
    const version = await t.run(ctx => ctx.db.get("documentVersions", versionId));
    expect(version?.status).toBe("ready_for_review");
    await expect(manager.client.mutation(ref, { ...input, filename: "swapped.txt", issuedAt, signature })).rejects.toThrow("UPLOAD_PROOF_INVALID");
  } finally { vi.unstubAllEnvs(); }
});

it("isolates documents between sibling jurisdictions and rejects mixed route IDs",async()=>{
  vi.stubEnv("ADMIN_MAX_DOCUMENT_BYTES","4194304");
  try {
    const t=createWidgetBackend(),a=await seedPublicWidget(t),b=await seedPublicWidget(t),manager=await addOrganizationMember(t,a.organizationId,"manager");
    await t.run(ctx=>ctx.db.patch(b.jurisdictionId,{organizationId:a.organizationId}));
    const list=makeFunctionReference<"query">("organizationContent:listResources"),get=makeFunctionReference<"query">("organizationContent:getResource");
    const data=await manager.client.query(list,{organizationId:a.organizationId,jurisdictionId:a.jurisdictionId,paginationOpts:{numItems:20,cursor:null}});
    expect(data.page.map((row:{_id:string})=>row._id)).toEqual([a.resourceId]);
    await expect(manager.client.query(get,{organizationId:a.organizationId,jurisdictionId:a.jurisdictionId,resourceId:b.resourceId})).rejects.toThrow("ORGANIZATION_ACCESS_DENIED");
  } finally { vi.unstubAllEnvs(); }
});
