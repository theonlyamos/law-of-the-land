import { expect, it } from "vitest";
import { createWidgetBackend, seedPublicWidget, seedGeographicWidget } from "../widgetTestHelpers.fixture";
import { resolveWidgetAuthority } from "./widgetAuthority";

it("resolves only the selected public organization and denies private or foreign frames", async () => {
  const t = createWidgetBackend();
  const f = await seedPublicWidget(t);
  expect((await t.run(ctx => resolveWidgetAuthority(ctx, f.publicId, "https://greenfield.example"))).store.relation).toBe("selected");
  await expect(t.run(ctx => resolveWidgetAuthority(ctx, f.publicId, "https://attacker.example"))).rejects.toThrow("WIDGET_UNAVAILABLE");
  await t.run(ctx => ctx.db.patch(f.jurisdictionId, { visibility: "members" }));
  await expect(t.run(ctx => resolveWidgetAuthority(ctx, f.publicId, "https://greenfield.example"))).rejects.toThrow("WIDGET_UNAVAILABLE");
});

it("rejects non-public, disabled, untyped, or misowned geographical libraries", async () => {
  const t = createWidgetBackend(), f = await seedGeographicWidget(t);
  expect((await t.run(ctx => resolveWidgetAuthority(ctx, f.publicId, "https://greenfield.example"))).store.kind).toBe("geographic");
  for (const patch of [{ status: "draft" as const }, { status: "archived" as const }, { visibility: "members" as const }, { kind: undefined }, { organizationId: f.organizationId }]) {
    await t.run(ctx => ctx.db.patch(f.jurisdictionId, patch));
    await expect(t.run(ctx => resolveWidgetAuthority(ctx, f.publicId, "https://greenfield.example"))).rejects.toThrow("WIDGET_UNAVAILABLE");
    await t.run(ctx => ctx.db.patch(f.jurisdictionId, { status: "enabled", visibility: "public", kind: "geographic", organizationId: undefined }));
  }
  await t.run(async ctx => {
    const profile = await ctx.db.query("geographicJurisdictions").withIndex("by_jurisdictionId", q => q.eq("jurisdictionId", f.jurisdictionId)).unique();
    await ctx.db.delete(profile!._id);
  });
  await expect(t.run(ctx => resolveWidgetAuthority(ctx, f.publicId, "https://greenfield.example"))).rejects.toThrow("WIDGET_UNAVAILABLE");
});
