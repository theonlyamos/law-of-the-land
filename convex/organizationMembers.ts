import { ConvexError, v } from "convex/values";
import { makeFunctionReference, paginationOptsValidator } from "convex/server";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Id, Doc } from "./_generated/dataModel";
import { authComponent } from "./auth";
import { components } from "./_generated/api";
import { organizationRoleValidator } from "./lib/widgetContracts";
import {
  requireOrganizationAccess,
  requireOrganizationOwner,
} from "./lib/organizationAccess";
import {
  assertMembershipCapacity,
  assertOwnerCapacity,
  finishOrganizationOperation,
  INVITATION_LIFETIME_MS,
  MAX_ORGANIZATION_INVITATIONS,
  organizationOperation,
  organizationRate,
  validatePageSize,
  verifiedOrganizationUser,
} from "./lib/organizationManagement";
import { consumeStepUp } from "./admin/publication";
import { writeAudit } from "./admin/audit";
import { sendEmail } from "./lib/email";

const sendRef = makeFunctionReference<"action">(
  "organizationMembers:sendInvitationEmail",
);
const deliveryRef = makeFunctionReference<"query">(
  "organizationMembers:getInvitationDelivery",
);
const recordRef = makeFunctionReference<"mutation">(
  "organizationMembers:recordInvitationDelivery",
);
const invitationArgs = { invitationId: v.id("organizationInvitations") };
async function audit(
  ctx: MutationCtx,
  actor: { userId: string; organizationId: Id<"organizations"> },
  action: string,
  targetId: string,
) {
  await writeAudit(ctx, {
    actorId: actor.userId,
    actorRoles: [],
    organizationId: actor.organizationId,
    action,
    targetType: "organizationMembership",
    targetId,
    outcome: "success",
  });
}
export const listMembers = query({
  args: {
    organizationId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireOrganizationAccess(ctx, args.organizationId, "read");
    validatePageSize(args.paginationOpts.numItems);
    const organization = await ctx.db.get(args.organizationId);
    const result = await ctx.db
      .query("organizationMemberships")
      .withIndex("by_organizationId_and_status", (q) =>
        q.eq("organizationId", args.organizationId).eq("status", "active"),
      )
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: await Promise.all(
        result.page.map(async (row) => ({
          id: row._id,
          name:
            (await authComponent.getAnyUserById(ctx, row.userId))?.name ??
            "Former account",
          role: row.role ?? "member",
          isOwner: organization?.ownerUserId === row.userId,
        })),
      ),
    };
  },
});
const memberArgs = {
  organizationId: v.id("organizations"),
  membershipId: v.id("organizationMemberships"),
  confirmation: v.string(),
  idempotencyKey: v.string(),
};
async function memberChange(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    membershipId: Id<"organizationMemberships">;
    confirmation: string;
    idempotencyKey: string;
    role?: "member" | "manager" | "reviewer";
  },
  operation: "role" | "remove" | "transfer",
) {
  const session = await verifiedOrganizationUser(ctx);
  const action =
    operation === "role"
      ? "organization_member_role"
      : operation === "remove"
        ? "organization_member_remove"
        : "organization_owner_transfer";
  const receipt = await organizationOperation(
    ctx,
    session.userId,
    action,
    args.idempotencyKey,
    {
      organizationId: args.organizationId,
      membershipId: args.membershipId,
      role: args.role ?? null,
      confirmation: args.confirmation,
    },
  );
  if (receipt.old) return null;
  const owner = await requireOrganizationOwner(ctx, args.organizationId);
  const member = await ctx.db.get(args.membershipId);
  if (
    !member ||
    member.organizationId !== args.organizationId ||
    member.status !== "active"
  )
    throw new ConvexError("ORGANIZATION_ACCESS_DENIED");
  if (member.userId === owner.userId)
    throw new ConvexError("ORGANIZATION_OWNER_TRANSFER_REQUIRED");
  const expected =
    operation === "role"
      ? `ROLE ${member._id} ${args.role}`
      : `${operation === "remove" ? "REMOVE" : "TRANSFER"} ${member._id}`;
  if (args.confirmation !== expected)
    throw new ConvexError("ADMIN_CONFIRMATION_MISMATCH");
  await consumeStepUp(
    ctx,
    owner.userId,
    owner.sessionId,
    action,
    member._id,
    args.idempotencyKey,
  );
  if (operation === "transfer") {
    const account = await authComponent.getAnyUserById(ctx, member.userId);
    if (!account || account.banned || !account.emailVerified) throw new ConvexError("ORGANIZATION_OWNER_ASSIGNMENT_INVALID");
    await assertOwnerCapacity(ctx, member.userId);
    await ctx.db.patch(args.organizationId, {
      ownerUserId: member.userId,
      updatedAt: Date.now(),
      updatedBy: owner.userId,
    });
    await ctx.db.patch(member._id, { role: "manager", updatedAt: Date.now() });
  } else if (operation === "remove")
    await ctx.db.patch(member._id, {
      status: "inactive",
      updatedAt: Date.now(),
    });
  else
    await ctx.db.patch(member._id, { role: args.role!, updatedAt: Date.now() });
  await finishOrganizationOperation(
    ctx,
    owner.userId,
    action,
    args.idempotencyKey,
    receipt.fingerprint,
    member._id,
  );
  await audit(ctx, owner, `organization.member_${operation}`, member._id);
  return null;
}
export const changeRole = mutation({
  args: { ...memberArgs, role: organizationRoleValidator },
  returns: v.null(),
  handler: (ctx, args) => memberChange(ctx, args, "role"),
});
export const removeMember = mutation({
  args: memberArgs,
  returns: v.null(),
  handler: (ctx, args) => memberChange(ctx, args, "remove"),
});
export const transferOwnership = mutation({
  args: memberArgs,
  returns: v.null(),
  handler: (ctx, args) => memberChange(ctx, args, "transfer"),
});
export const leave = mutation({
  args: { organizationId: v.id("organizations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireOrganizationAccess(
      ctx,
      args.organizationId,
      "read",
    );
    await verifiedOrganizationUser(ctx);
    if (actor.isOwner)
      throw new ConvexError("ORGANIZATION_OWNER_TRANSFER_REQUIRED");
    const member = await ctx.db
      .query("organizationMemberships")
      .withIndex("by_organizationId_and_userId", (q) =>
        q.eq("organizationId", args.organizationId).eq("userId", actor.userId),
      )
      .unique();
    await ctx.db.patch(member!._id, {
      status: "inactive",
      updatedAt: Date.now(),
    });
    await audit(ctx, actor, "organization.member_left", member!._id);
    return null;
  },
});
export const invite = mutation({
  args: {
    organizationId: v.id("organizations"),
    email: v.string(),
    role: organizationRoleValidator,
  },
  returns: v.id("organizationInvitations"),
  handler: async (ctx, args) => {
    const owner = await requireOrganizationOwner(ctx, args.organizationId);
    const email = args.email.trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new ConvexError("ORGANIZATION_EMAIL_INVALID");
    const existingUser = await ctx.runQuery(
      components.betterAuth.adapter.findOne,
      {
        model: "user",
        where: [{ field: "email", operator: "eq", value: email }],
      },
    );
    if (existingUser) {
      const membership = await ctx.db
        .query("organizationMemberships")
        .withIndex("by_organizationId_and_userId", (q) =>
          q
            .eq("organizationId", args.organizationId)
            .eq("userId", existingUser._id),
        )
        .unique();
      if (membership?.status === "active")
        throw new ConvexError("ORGANIZATION_ALREADY_MEMBER");
    }
    const now = Date.now();
    const old = await ctx.db
      .query("organizationInvitations")
      .withIndex(
        "by_organizationId_and_normalizedEmail_and_state_and_expiresAt",
        (q) =>
          q
            .eq("organizationId", args.organizationId)
            .eq("normalizedEmail", email)
            .eq("state", "pending")
            .gt("expiresAt", now),
      )
      .first();
    if (old) return old._id;
    const pending = await ctx.db
      .query("organizationInvitations")
      .withIndex("by_organizationId_and_state_and_expiresAt", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("state", "pending")
          .gt("expiresAt", now),
      )
      .take(MAX_ORGANIZATION_INVITATIONS);
    if (pending.length >= MAX_ORGANIZATION_INVITATIONS)
      throw new ConvexError("ORGANIZATION_INVITATION_LIMIT");
    await organizationRate(
      ctx,
      "organization_invitation_send",
      owner.userId,
      20,
    );
    const invitationId = await ctx.db.insert("organizationInvitations", {
      organizationId: args.organizationId,
      normalizedEmail: email,
      role: args.role,
      inviterUserId: owner.userId,
      expiresAt: now + INVITATION_LIFETIME_MS,
      state: "pending",
      deliveryState: "queued",
      deliveryAttempt: 1,
      lastDeliveryRequestedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, sendRef, {
      invitationId,
      deliveryAttempt: 1,
    });
    await audit(ctx, owner, "organization.invitation_created", invitationId);
    return invitationId;
  },
});
async function recipientInvitation(
  ctx: QueryCtx | MutationCtx,
  id: Id<"organizationInvitations">,
) {
  const actor = await verifiedOrganizationUser(ctx);
  const invitation = await ctx.db.get(id);
  const organization = invitation
    ? await ctx.db.get(invitation.organizationId)
    : null;
  if (
    !invitation ||
    invitation.normalizedEmail !== actor.email ||
    organization?.status !== "active"
  )
    throw new ConvexError("ORGANIZATION_INVITATION_UNAVAILABLE");
  return { actor, invitation, organization };
}
export const acceptInvitation = mutation({
  args: invitationArgs,
  returns: v.id("organizations"),
  handler: async (ctx, args) => {
    const { actor, invitation } = await recipientInvitation(
      ctx,
      args.invitationId,
    );
    if (
      invitation.state === "accepted" &&
      invitation.acceptedByUserId === actor.userId
    )
      return invitation.organizationId;
    if (invitation.state !== "pending" || invitation.expiresAt <= Date.now())
      throw new ConvexError("ORGANIZATION_INVITATION_UNAVAILABLE");
    const member = await ctx.db
      .query("organizationMemberships")
      .withIndex("by_organizationId_and_userId", (q) =>
        q
          .eq("organizationId", invitation.organizationId)
          .eq("userId", actor.userId),
      )
      .unique();
    if (member?.status !== "active") {
      await assertMembershipCapacity(ctx, actor.userId);
      if (member)
        await ctx.db.patch(member._id, {
          status: "active",
          role: invitation.role,
          updatedAt: Date.now(),
        });
      else
        await ctx.db.insert("organizationMemberships", {
          organizationId: invitation.organizationId,
          userId: actor.userId,
          status: "active",
          role: invitation.role,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
    }
    await ctx.db.patch(invitation._id, {
      state: "accepted",
      acceptedByUserId: actor.userId,
      updatedAt: Date.now(),
    });
    await audit(
      ctx,
      { ...actor, organizationId: invitation.organizationId },
      "organization.invitation_accepted",
      invitation._id,
    );
    return invitation.organizationId;
  },
});
export const declineInvitation = mutation({
  args: invitationArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const { actor, invitation } = await recipientInvitation(
      ctx,
      args.invitationId,
    );
    if (invitation.state !== "pending" || invitation.expiresAt <= Date.now())
      throw new ConvexError("ORGANIZATION_INVITATION_UNAVAILABLE");
    await ctx.db.patch(invitation._id, {
      state: "declined",
      updatedAt: Date.now(),
    });
    await audit(
      ctx,
      { ...actor, organizationId: invitation.organizationId },
      "organization.invitation_declined",
      invitation._id,
    );
    return null;
  },
});
async function ownerInvitation(
  ctx: MutationCtx,
  id: Id<"organizationInvitations">,
) {
  const invitation = await ctx.db.get(id);
  if (!invitation) throw new ConvexError("ORGANIZATION_INVITATION_UNAVAILABLE");
  const owner = await requireOrganizationOwner(ctx, invitation.organizationId);
  if (invitation.state !== "pending" || invitation.expiresAt <= Date.now())
    throw new ConvexError("ORGANIZATION_INVITATION_UNAVAILABLE");
  return { invitation, owner };
}
export const revokeInvitation = mutation({
  args: invitationArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const { invitation, owner } = await ownerInvitation(ctx, args.invitationId);
    await ctx.db.patch(invitation._id, {
      state: "revoked",
      updatedAt: Date.now(),
    });
    await audit(ctx, owner, "organization.invitation_revoked", invitation._id);
    return null;
  },
});
export const resendInvitation = mutation({
  args: invitationArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const { invitation, owner } = await ownerInvitation(ctx, args.invitationId);
    if (Date.now() - invitation.lastDeliveryRequestedAt < 60_000)
      throw new ConvexError("ORGANIZATION_INVITATION_COOLDOWN");
    await organizationRate(
      ctx,
      "organization_invitation_send",
      owner.userId,
      20,
    );
    const deliveryAttempt = invitation.deliveryAttempt + 1;
    await ctx.db.patch(invitation._id, {
      deliveryState: "queued",
      deliveryAttempt,
      lastDeliveryRequestedAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, sendRef, {
      invitationId: invitation._id,
      deliveryAttempt,
    });
    await audit(ctx, owner, "organization.invitation_resent", invitation._id);
    return null;
  },
});
function invitationView(row: Doc<"organizationInvitations">) {
  return {
    id: row._id,
    organizationId: row.organizationId,
    role: row.role,
    expiresAt: row.expiresAt,
    state: row.state,
    deliveryState: row.deliveryState,
  };
}
export const listInvitations = query({
  args: {
    organizationId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireOrganizationOwner(ctx, args.organizationId);
    validatePageSize(args.paginationOpts.numItems);
    const result = await ctx.db
      .query("organizationInvitations")
      .withIndex("by_organizationId_and_state_and_expiresAt", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("state", "pending"),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    return {
      ...result,
      // Keep the indexed range stable when a live subscription reuses its cursor.
      page: result.page.filter(row => row.expiresAt > Date.now()).map((row) => ({
        ...invitationView(row),
        email: row.normalizedEmail,
      })),
    };
  },
});
export const listMyInvitations = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const actor = await verifiedOrganizationUser(ctx);
    validatePageSize(args.paginationOpts.numItems);
    const result = await ctx.db
      .query("organizationInvitations")
      .withIndex("by_normalizedEmail_and_state_and_expiresAt", (q) =>
        q
          .eq("normalizedEmail", actor.email)
          .eq("state", "pending"),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    const page = await Promise.all(
      result.page.filter(row => row.expiresAt > Date.now()).map(async (row) => {
        const org = await ctx.db.get(row.organizationId);
        return org?.status === "active"
          ? { ...invitationView(row), organizationName: org.name }
          : null;
      }),
    );
    return { ...result, page: page.filter((row) => row !== null) };
  },
});
const deliveryArgs = {
  invitationId: v.id("organizationInvitations"),
  deliveryAttempt: v.number(),
};
export const getInvitationDelivery = internalQuery({
  args: deliveryArgs,
  handler: async (ctx, args) => {
    const invitation = await ctx.db.get(args.invitationId);
    const organization = invitation
      ? await ctx.db.get(invitation.organizationId)
      : null;
    if (
      !invitation ||
      invitation.state !== "pending" ||
      invitation.expiresAt <= Date.now() ||
      invitation.deliveryAttempt !== args.deliveryAttempt ||
      invitation.deliveryState !== "queued" ||
      organization?.status !== "active"
    )
      return null;
    return {
      email: invitation.normalizedEmail,
      organizationName: organization.name,
    };
  },
});
export const recordInvitationDelivery = internalMutation({
  args: {
    ...deliveryArgs,
    deliveryState: v.union(v.literal("sent"), v.literal("failed")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const invitation = await ctx.db.get(args.invitationId);
    if (
      invitation?.deliveryAttempt === args.deliveryAttempt &&
      invitation.deliveryState === "queued"
    )
      await ctx.db.patch(invitation._id, {
        deliveryState: args.deliveryState,
        updatedAt: Date.now(),
      });
    return null;
  },
});
export const sendInvitationEmail = internalAction({
  args: deliveryArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const delivery: { email: string; organizationName: string } | null =
      await ctx.runQuery(deliveryRef, args);
    if (!delivery) return null;
    let deliveryState: "sent" | "failed" = "failed";
    try {
      const origin = new URL(process.env.SITE_URL ?? "");
      if (origin.protocol !== "https:" || origin.username || origin.password)
        throw new Error("Invalid application origin");
      const url = new URL("/organizations", origin);
      url.searchParams.set("invitation", args.invitationId);
      const escape = (value: string) =>
        value.replace(
          /[&<>"']/g,
          (char) =>
            ({
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              '"': "&quot;",
              "'": "&#39;",
            })[char]!,
        );
      await sendEmail({
        to: delivery.email,
        subject: "Organization invitation — Law of the Land",
        html: `<p>You have been invited to ${escape(delivery.organizationName)}.</p><p><a href="${escape(url.toString())}">View invitation</a></p><p>Sign in with the email address that received this invitation. It expires seven days after creation.</p>`,
      });
      deliveryState = "sent";
    } catch {
      /* Delivery failure is displayed to the owner; do not log recipient data. */
    }
    await ctx.runMutation(recordRef, { ...args, deliveryState });
    return null;
  },
});

export const getMyInvitation = query({
  args: { invitationId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("organizationInvitations", args.invitationId);
    if (!id) return null;
    try {
      const { invitation, organization } = await recipientInvitation(ctx, id);
      return invitation.state === "pending" && invitation.expiresAt > Date.now()
        ? {
            id,
            organizationName: organization.name,
            role: invitation.role,
            expiresAt: invitation.expiresAt,
          }
        : null;
    } catch {
      return null;
    }
  },
});
