import { expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import {
  addAssuredOrganizationUser,
  addOrganizationMember,
  createWidgetBackend,
  seedPublicWidget,
} from "./widgetTestHelpers.fixture";

it("binds invitations to verified accounts and never reactivates an accepted invitation", async () => {
  const t = createWidgetBackend(),
    f = await seedPublicWidget(t);
  const owner = await addOrganizationMember(t, f.organizationId, "manager");
  const recipient = await addAssuredOrganizationUser(t),
    wrong = await addAssuredOrganizationUser(t);
  await t.run((ctx) =>
    ctx.db.patch(f.organizationId, { ownerUserId: owner.userId }),
  );
  const invite = makeFunctionReference<"mutation">(
    "organizationMembers:invite",
  );
  const accept = makeFunctionReference<"mutation">(
    "organizationMembers:acceptInvitation",
  );
  const input = {
    organizationId: f.organizationId,
    email: recipient.email,
    role: "reviewer",
  };
  const invitationId = await owner.client.mutation(invite, input);
  expect(await owner.client.mutation(invite, input)).toBe(invitationId);
  await expect(owner.client.mutation(invite, { ...input, role: "manager" })).rejects.toThrow("ORGANIZATION_INVITATION_ROLE_CONFLICT");
  await expect(wrong.client.mutation(accept, { invitationId })).rejects.toThrow(
    "ORGANIZATION_INVITATION_UNAVAILABLE",
  );
  expect(await recipient.client.mutation(accept, { invitationId })).toBe(
    f.organizationId,
  );
  await t.run(async (ctx) => {
    const member = await ctx.db
      .query("organizationMemberships")
      .withIndex("by_organizationId_and_userId", (q) =>
        q.eq("organizationId", f.organizationId).eq("userId", recipient.userId),
      )
      .unique();
    await ctx.db.patch(member!._id, { status: "inactive" });
  });
  await recipient.client.mutation(accept, { invitationId });
  const member = await t.run((ctx) =>
    ctx.db
      .query("organizationMemberships")
      .withIndex("by_organizationId_and_userId", (q) =>
        q.eq("organizationId", f.organizationId).eq("userId", recipient.userId),
      )
      .unique(),
  );
  expect(member?.status).toBe("inactive");
});

it("keeps invitation pagination valid as time and delivery status change", async () => {
  const t = createWidgetBackend(), f = await seedPublicWidget(t);
  const owner = await addOrganizationMember(t, f.organizationId, "manager");
  await t.run(ctx => ctx.db.patch(f.organizationId, { ownerUserId: owner.userId }));
  const invite = makeFunctionReference<"mutation">("organizationMembers:invite");
  for (const email of ["first@example.org", "second@example.org"]) await owner.client.mutation(invite, { organizationId: f.organizationId, email, role: "member" });
  const list = makeFunctionReference<"query">("organizationMembers:listInvitations");
  const first = await owner.client.query(list, { organizationId: f.organizationId, paginationOpts: { numItems: 1, cursor: null } });
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1_000);
  try {
    await t.run(ctx => ctx.db.patch(first.page[0].id, { deliveryState: "failed" }));
    const next = await owner.client.query(list, { organizationId: f.organizationId, paginationOpts: { numItems: 1, cursor: first.continueCursor } });
    expect(next.page).toHaveLength(1);
    expect(next.page[0].id).not.toBe(first.page[0].id);
  } finally { clock.mockRestore(); }
});

it("transfers ownership with step-up and immediately changes review authority", async () => {
  const t = createWidgetBackend(),
    f = await seedPublicWidget(t),
    owner = await addOrganizationMember(t, f.organizationId, "manager"),
    next = await addOrganizationMember(t, f.organizationId, "member");
  await t.run((ctx) =>
    ctx.db.patch(f.organizationId, { ownerUserId: owner.userId }),
  );
  const proof = makeFunctionReference<"mutation">(
      "admin/users:recordAdminStepUpProof",
    ),
    transfer = makeFunctionReference<"mutation">(
      "organizationMembers:transferOwnership",
    ),
    workspace = makeFunctionReference<"query">(
      "organizations:getOrganizationWorkspace",
    );
  const input = {
    organizationId: f.organizationId,
    membershipId: next.membershipId,
    confirmation: `TRANSFER ${next.membershipId}`,
    idempotencyKey: "transfer_owner_test",
    reason: "Transfer responsibility to successor",
  };
  await expect(owner.client.mutation(transfer, input)).rejects.toThrow();
  await t.mutation(proof, {
    actorId: owner.userId,
    sessionId: owner.sessionId,
    action: "organization_owner_transfer",
    targetId: next.membershipId,
    idempotencyKey: input.idempotencyKey,
  });
  await owner.client.mutation(transfer, input);
  await owner.client.mutation(transfer, input);
  const events = await t.run(ctx => ctx.db.query("auditEvents").collect());
  expect(events.find(event => event.action === "organization.member_transfer")?.reason).toBe(input.reason);
  expect(
    await next.client.query(workspace, { organizationId: f.organizationId }),
  ).toMatchObject({
    canReview: true,
    canManageMembers: true,
    organization: { isOwner: true, role: "manager" },
  });
  expect(
    await owner.client.query(workspace, { organizationId: f.organizationId }),
  ).toMatchObject({
    canReview: false,
    canManageMembers: false,
    organization: { isOwner: false, role: "manager" },
  });
  await expect(
    next.client.mutation(
      makeFunctionReference<"mutation">("organizationMembers:leave"),
      { organizationId: f.organizationId },
    ),
  ).rejects.toThrow("ORGANIZATION_OWNER_TRANSFER_REQUIRED");
});
