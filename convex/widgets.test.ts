import { afterEach, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { addOrganizationMember, createWidgetBackend, seedPublicWidget } from "./widgetTestHelpers.fixture";
const get = makeFunctionReference<"query">("widgets:getSettings"), save = makeFunctionReference<"mutation">("widgets:saveSettings");
afterEach(() => vi.unstubAllEnvs());
it("limits settings to managers, preserves the public ID, and revokes access changes", async () => {
  const t = createWidgetBackend(), f = await seedPublicWidget(t), manager = await addOrganizationMember(t, f.organizationId, "manager"), reviewer = await addOrganizationMember(t, f.organizationId, "reviewer");
  const current = await manager.client.query(get, { organizationId: f.organizationId });
  const input = { organizationId: f.organizationId, settings: { ...current.settings, title: "Ask Greenfield policy" }, dailyLimit: 100, monthlyLimit: 1000 };
  await expect(reviewer.client.mutation(save, input)).rejects.toThrow("ORGANIZATION_ACCESS_DENIED");
  expect(await manager.client.mutation(save, input)).toBe(f.publicId);
  expect((await t.run(ctx => ctx.db.get(f.widgetId)))?.accessVersion).toBe(0);
  await manager.client.mutation(save, { ...input, settings: { ...input.settings, enabled: false } });
  expect((await t.run(ctx => ctx.db.get(f.widgetId)))?.accessVersion).toBe(1);
  await expect(manager.client.mutation(save, { ...input, dailyLimit: 101 })).rejects.toThrow("WIDGET_ALLOWANCE_INVALID");
  const event = await t.run(ctx => ctx.db.query("auditEvents").order("desc").first());
  expect(event?.organizationId).toBe(f.organizationId); expect(event?.organizationRole).toBe("manager");
});

it("allows presentation edits only within the manager's organization", async () => {
  const t = createWidgetBackend(), own = await seedPublicWidget(t), other = await seedPublicWidget(t), manager = await addOrganizationMember(t, own.organizationId, "manager");
  const presentation = makeFunctionReference<"mutation">("organizations:setPresentation");
  await expect(manager.client.mutation(presentation, { organizationId: other.organizationId, name: "Changed", reason: "Update presentation" })).rejects.toThrow("ORGANIZATION_ACCESS_DENIED");
  await manager.client.mutation(presentation, { organizationId: own.organizationId, name: "Greenfield Policies", reason: "Update presentation" });
  const jurisdiction = await t.run(ctx => ctx.db.get(own.jurisdictionId));
  expect(jurisdiction?.name).toBe("Greenfield Policies"); expect(jurisdiction?.contentRevision).toBe(1);
});
