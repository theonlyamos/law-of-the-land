import { afterEach, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { addOrganizationMember, createWidgetBackend, seedPublicWidget, seedGeographicWidget } from "./widgetTestHelpers.fixture";
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

it("uses jurisdiction admin permissions for geographical settings and preserves ownership boundaries", async () => {
  vi.stubEnv("ADMIN_PANEL_ENABLED", "true"); vi.stubEnv("ADMIN_ENVIRONMENT", "test");
  const t = createWidgetBackend(), geo = await seedGeographicWidget(t), org = await seedPublicWidget(t);
  await t.run(ctx => ctx.db.insert("featureFlags", { key: "admin_panel", environment: "test", enabled: true, updatedAt: Date.now() }));
  const admin = await addOrganizationMember(t, org.organizationId, "member", "content_manager");
  const auditor = await addOrganizationMember(t, org.organizationId, "member", "auditor");
  const manager = await addOrganizationMember(t, org.organizationId, "manager");
  const target = { jurisdictionId: geo.jurisdictionId };
  expect((await auditor.client.query(get, target)).canManage).toBe(false);
  await expect(manager.client.query(get, target)).rejects.toThrow();
  const data = await admin.client.query(get, target);
  const input = { ...target, settings: { ...data.settings, title: "Ask the city" }, dailyLimit: 100, monthlyLimit: 1000 };
  await expect(auditor.client.mutation(save, input)).rejects.toThrow();
  expect(await admin.client.mutation(save, input)).toBe(geo.publicId);
  await expect(admin.client.mutation(save, { ...input, jurisdictionId: org.jurisdictionId })).rejects.toThrow("ORGANIZATION_ACCESS_DENIED");
  await expect(manager.client.mutation(save, { ...input, organizationId: org.organizationId })).rejects.toThrow("WIDGET_UNAVAILABLE");
  const setAllowance = makeFunctionReference<"mutation">("widgets:setWidgetAllowance");
  const limits = { ...target, platformDailyLimit: 2, platformMonthlyLimit: 10, maxConcurrent: 1, reason: "Set city pilot allowance" };
  await expect(manager.client.mutation(setAllowance, limits)).rejects.toThrow();
  await admin.client.mutation(setAllowance, limits);
  const updated = await admin.client.query(get, target);
  expect(updated.dailyLimit).toBe(2);
  expect((await manager.client.query(get, { organizationId: org.organizationId })).dailyLimit).toBe(100);
});

it("lets a manager enable a private jurisdiction without changing browsing visibility", async () => {
  const t = createWidgetBackend(), f = await seedPublicWidget(t);
  const manager = await addOrganizationMember(t, f.organizationId, "manager"), reviewer = await addOrganizationMember(t, f.organizationId, "reviewer");
  await t.run(ctx => ctx.db.patch(f.jurisdictionId, { visibility: "members" }));
  const data = await manager.client.query(get, { organizationId: f.organizationId });
  expect(data.ready).toBe(true);
  const input = { organizationId: f.organizationId, settings: data.settings, dailyLimit: 100, monthlyLimit: 1000 };
  await expect(reviewer.client.mutation(save, input)).rejects.toThrow("ORGANIZATION_ACCESS_DENIED");
  await manager.client.mutation(save, input);
  expect((await t.run(ctx => ctx.db.get(f.jurisdictionId)))?.visibility).toBe("members");
  await manager.client.mutation(save, { ...input, settings: { ...input.settings, enabled: false } });
  expect((await t.run(ctx => ctx.db.get(f.widgetId)))?.accessVersion).toBe(1);
});

it("targets sibling widgets explicitly without overwriting their shared allowance",async()=>{
  const t=createWidgetBackend(),a=await seedPublicWidget(t),b=await seedPublicWidget(t),manager=await addOrganizationMember(t,a.organizationId,"manager");
  await t.run(async ctx=>{await ctx.db.patch(b.jurisdictionId,{organizationId:a.organizationId});await ctx.db.patch(b.widgetId,{organizationId:a.organizationId});});
  await expect(manager.client.query(get,{organizationId:a.organizationId})).rejects.toThrow("ORGANIZATION_JURISDICTION_SELECTION_REQUIRED");
  const target={organizationId:a.organizationId,jurisdictionId:b.jurisdictionId};
  const data=await manager.client.query(get,target);
  await manager.client.mutation(makeFunctionReference<"mutation">("widgets:saveUsageLimits"),{...target,dailyLimit:7,monthlyLimit:50});
  await manager.client.mutation(save,{...target,settings:{...data.settings,title:"Sibling library"}});
  expect(await manager.client.query(get,{organizationId:a.organizationId,jurisdictionId:a.jurisdictionId})).toMatchObject({dailyLimit:7,monthlyLimit:50,settings:{title:"Ask Greenfield"}});
  expect(await manager.client.query(get,target)).toMatchObject({publicId:b.publicId,settings:{title:"Sibling library"}});
  await expect(manager.client.mutation(save,{...target,settings:data.settings,dailyLimit:100,monthlyLimit:1000})).rejects.toThrow("WIDGET_ALLOWANCE_INVALID");
  await expect(manager.client.query(get,{organizationId:b.organizationId,jurisdictionId:a.jurisdictionId})).rejects.toThrow();
});
