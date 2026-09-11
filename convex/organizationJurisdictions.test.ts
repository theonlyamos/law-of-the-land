import { afterEach, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import {
  addOrganizationMember,
  createWidgetBackend,
  seedPublicWidget,
  seedGeographicWidget,
} from "./widgetTestHelpers.fixture";

afterEach(() => vi.unstubAllEnvs());
it("validates and records a jurisdiction visibility change reason", async () => {
  const t = createWidgetBackend(), f = await seedPublicWidget(t);
  const manager = await addOrganizationMember(t, f.organizationId, "manager");
  const input = { organizationId: f.organizationId, jurisdictionId: f.jurisdictionId, visibility: "members", confirmation: `PRIVATE ${f.jurisdictionId}`, idempotencyKey: "visibility_reason_test", reason: "Restrict research audience" };
  const change = makeFunctionReference<"mutation">("organizationJurisdictions:setVisibility");
  await t.mutation(makeFunctionReference<"mutation">("admin/users:recordAdminStepUpProof"), { actorId: manager.userId, sessionId: manager.sessionId, action: "organization_visibility", targetId: f.jurisdictionId, idempotencyKey: input.idempotencyKey });
  await expect(manager.client.mutation(change, { ...input, reason: "" })).rejects.toThrow();
  await manager.client.mutation(change, input);
  const events = await t.run(ctx => ctx.db.query("auditEvents").collect());
  expect(events.find(event => event.action === "organization.visibility_set")?.reason).toBe(input.reason);
});
it("reads and reduces an eight-geography scope while rejecting a ninth link", async () => {
  const t = createWidgetBackend(), f = await seedPublicWidget(t);
  const owner = await addOrganizationMember(t, f.organizationId, "manager");
  await t.run(ctx => ctx.db.patch(f.organizationId, { ownerUserId: owner.userId }));
  const geographies = [];
  for (let i = 0; i < 9; i++) geographies.push((await seedGeographicWidget(t)).jurisdictionId);
  const update = makeFunctionReference<"mutation">("organizationJurisdictions:update");
  const get = makeFunctionReference<"query">("organizationJurisdictions:get");
  const target = { organizationId: f.organizationId, jurisdictionId: f.jurisdictionId };
  const input = { ...target, name: "Regional policies", scopeMode: "linked_geographies", geographicJurisdictionIds: geographies.slice(0, 8), reason: "Update geographic coverage" };
  await owner.client.mutation(update, input);
  expect((await owner.client.query(get, target)).geographicJurisdictions).toHaveLength(8);
  await expect(owner.client.mutation(update, { ...input, geographicJurisdictionIds: geographies })).rejects.toThrow("INVALID_SCOPE_MODE");
  await owner.client.mutation(update, { ...input, name: "Local policies", geographicJurisdictionIds: geographies.slice(0, 1) });
  const reduced = await owner.client.query(get, target);
  expect(reduced.jurisdiction.name).toBe("Local policies");
  expect(reduced.geographicJurisdictions).toHaveLength(1);
});
it("creates independent sibling libraries and retries without duplicate provider jobs", async () => {
  vi.stubEnv("ADMIN_ENVIRONMENT", "test");
  const t = createWidgetBackend(),
    f = await seedPublicWidget(t),
    manager = await addOrganizationMember(t, f.organizationId, "manager");
  const create = makeFunctionReference<"mutation">(
    "organizationJurisdictions:create",
  );
  const args = {
    organizationId: f.organizationId,
    name: "Employment policies",
    scopeMode: "global",
    geographicJurisdictionIds: [],
    idempotencyKey: "employment_create_01",
  };
  const id = await manager.client.mutation(create, args);
  expect(await manager.client.mutation(create, args)).toBe(id);
  expect(id).not.toBe(f.jurisdictionId);
  const rows = await t.run((ctx) => ctx.db.query("jurisdictions").collect());
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row._id === id)).toMatchObject({
    name: args.name,
    status: "draft",
    visibility: "members",
    organizationId: f.organizationId,
  });
  expect(
    await t.run((ctx) => ctx.db.query("integrationJobs").collect()),
  ).toHaveLength(1);
  await t.run(async ctx => {
    const job = (await ctx.db.query("integrationJobs").collect())[0];
    await ctx.db.patch(job._id, { status: "manual_review", recoveryKind: "apply_store_result", knownStoreResult: { kind: "store_created", storeName: "fileSearchStores/retry-reason", embeddingModel: "models/gemini-embedding-2" } });
  });
  const reason = "Resume verified setup result";
  await manager.client.mutation(makeFunctionReference<"mutation">("organizationJurisdictions:retrySetup"), { organizationId: f.organizationId, jurisdictionId: id, idempotencyKey: "setup_reason_test", reason });
  const events = await t.run(ctx => ctx.db.query("auditEvents").collect());
  expect(events.find(event => event.action === "integration.job_retry")?.reason).toBe(reason);
});
