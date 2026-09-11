import { expect, it } from "vitest";
import { makeFunctionReference } from "convex/server";
import {
  createWidgetBackend,
  addAssuredOrganizationUser,
} from "./widgetTestHelpers.fixture";

it("creates one owned organization for an exact retry without provisioning a library", async () => {
  const t = createWidgetBackend();
  const user = await addAssuredOrganizationUser(t);
  const create = makeFunctionReference<"mutation">(
    "organizations:createOrganization",
  );
  const input = {
    name: "Northbridge",
    class: "university",
    idempotencyKey: "create_northbridge_01",
  };
  const id = await user.client.mutation(create, input);
  expect(await user.client.mutation(create, input)).toBe(id);
  const rows = await t.run((ctx) => ctx.db.query("organizations").collect());
  expect(rows).toMatchObject([{ _id: id, ownerUserId: user.userId }]);
  expect(
    await t.run((ctx) => ctx.db.query("organizationMemberships").collect()),
  ).toMatchObject([
    {
      organizationId: id,
      userId: user.userId,
      role: "manager",
      status: "active",
    },
  ]);
  expect(
    await t.run((ctx) => ctx.db.query("integrationJobs").collect()),
  ).toHaveLength(0);
  await expect(
    user.client.mutation(create, { ...input, name: "Changed" }),
  ).rejects.toThrow("ORGANIZATION_REQUEST_CONFLICT");
});

it("suspends all jurisdictions and keeps widgets disabled after restore", async () => {
  const { seedPublicWidget, addOrganizationMember } =
    await import("./widgetTestHelpers.fixture");
  const t = createWidgetBackend(),
    a = await seedPublicWidget(t),
    b = await seedPublicWidget(t),
    owner = await addOrganizationMember(t, a.organizationId, "manager");
  await t.run(async (ctx) => {
    await ctx.db.patch(a.organizationId, { ownerUserId: owner.userId });
    await ctx.db.patch(b.jurisdictionId, { organizationId: a.organizationId });
    await ctx.db.patch(b.widgetId, { organizationId: a.organizationId });
  });
  const proof = makeFunctionReference<"mutation">(
    "admin/users:recordAdminStepUpProof",
  );
  const archive = makeFunctionReference<"mutation">("organizations:archive"),
    restore = makeFunctionReference<"mutation">("organizations:restore"),
    accessible = makeFunctionReference<"query">(
      "jurisdictions:getAccessibleById",
    );
  const input = {
    organizationId: a.organizationId,
    idempotencyKey: "archive_org_test",
    confirmation: `ARCHIVE ${a.organizationId}`,
    reason: "Suspend unused organization",
  };
  await expect(owner.client.mutation(archive, input)).rejects.toThrow();
  await t.mutation(proof, {
    actorId: owner.userId,
    sessionId: owner.sessionId,
    action: "organization_archive",
    targetId: a.organizationId,
    idempotencyKey: input.idempotencyKey,
  });
  await owner.client.mutation(archive, input);
  expect(await t.query(accessible, { id: a.jurisdictionId })).toBeNull();
  expect(await t.query(accessible, { id: b.jurisdictionId })).toBeNull();
  await t.mutation(proof, {
    actorId: owner.userId,
    sessionId: owner.sessionId,
    action: "organization_restore",
    targetId: a.organizationId,
    idempotencyKey: "restore_org_test",
  });
  await owner.client.mutation(restore, {
    organizationId: a.organizationId,
    idempotencyKey: "restore_org_test",
    confirmation: `RESTORE ${a.organizationId}`,
    reason: "Resume organization operations",
  });
  expect(await t.query(accessible, { id: a.jurisdictionId })).not.toBeNull();
  const events = await t.run(ctx => ctx.db.query("auditEvents").collect());
  expect(events.find(event => event.action === "organization.archived")?.reason).toBe(input.reason);
  expect(events.find(event => event.action === "organization.restored")?.reason).toBe("Resume organization operations");
  expect(
    await t.run((ctx) =>
      Promise.all([ctx.db.get(a.widgetId), ctx.db.get(b.widgetId)]),
    ),
  ).toEqual([
    expect.objectContaining({ enabled: false, accessVersion: 1 }),
    expect.objectContaining({ enabled: false, accessVersion: 1 }),
  ]);
});
