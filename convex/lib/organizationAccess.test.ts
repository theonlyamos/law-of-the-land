import { expect, it } from "vitest";
import { createWidgetBackend, seedPublicWidget, addOrganizationMember } from "../widgetTestHelpers.fixture";
import { requireOrganizationAccess } from "./organizationAccess";

it("keeps organization roles scoped, revocable, and separate from platform roles", async () => {
  const t = createWidgetBackend();
  const a = await seedPublicWidget(t);
  const b = await seedPublicWidget(t);
  const manager = await addOrganizationMember(t, a.organizationId, "manager");
  expect((await manager.client.run(ctx => requireOrganizationAccess(ctx, a.organizationId, "manage"))).organizationRole).toBe("manager");
  await expect(manager.client.run(ctx => requireOrganizationAccess(ctx, b.organizationId, "manage"))).rejects.toThrow("ORGANIZATION_ACCESS_DENIED");
  await expect(manager.client.run(ctx => requireOrganizationAccess(ctx, a.organizationId, "review"))).rejects.toThrow("ORGANIZATION_ACCESS_DENIED");
  await t.run(ctx => ctx.db.patch(manager.membershipId, { role: undefined }));
  await expect(manager.client.run(ctx => requireOrganizationAccess(ctx, a.organizationId, "manage"))).rejects.toThrow("ORGANIZATION_ACCESS_DENIED");
  await t.run(ctx => ctx.db.patch(manager.membershipId, { status: "inactive" }));
  await expect(manager.client.run(ctx => requireOrganizationAccess(ctx, a.organizationId, "read"))).rejects.toThrow("ORGANIZATION_ACCESS_DENIED");
});
