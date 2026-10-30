import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { mutation, query } from "../_generated/server";
import { supportCategoryValidator, supportStatusValidator } from "../support";
import { SUPPORT_LIMITS, SUPPORT_STATUS_LABELS } from "../../shared/support";
import { writeAudit } from "./audit";
import { requireEnabledAdminPermission } from "./featureFlags";

// Support agents already hold these permissions, so the inbox needs no new role.
const READ: [string, string] = ["user", "read"];
const WRITE: [string, string] = ["user", "support"];
const MAX_PAGE = 50;
const MAX_NOTES = 100;
const TRIAGE_REASON = "Contact and feedback triage";

const ticketRowValidator = v.object({
  id: v.id("supportTickets"),
  category: supportCategoryValidator,
  subject: v.string(),
  status: supportStatusValidator,
  name: v.optional(v.string()),
  email: v.string(),
  signedIn: v.boolean(),
  hasScreenshot: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

function row(ticket: Doc<"supportTickets">) {
  return {
    id: ticket._id,
    category: ticket.category,
    subject: ticket.subject,
    status: ticket.status,
    name: ticket.name,
    email: ticket.email,
    signedIn: ticket.userId !== undefined,
    hasScreenshot: ticket.screenshotId !== undefined,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
}

export const listTickets = query({
  args: {
    paginationOpts: paginationOptsValidator,
    status: v.optional(supportStatusValidator),
    category: v.optional(supportCategoryValidator),
  },
  returns: v.object({ page: v.array(ticketRowValidator), isDone: v.boolean(), continueCursor: v.string() }),
  handler: async (ctx, args) => {
    await requireEnabledAdminPermission(ctx, ...READ);
    if (!Number.isInteger(args.paginationOpts.numItems) || args.paginationOpts.numItems < 1) {
      throw new ConvexError("INVALID_ADMIN_PAGINATION");
    }
    const opts = { ...args.paginationOpts, numItems: Math.min(args.paginationOpts.numItems, MAX_PAGE), maximumRowsRead: MAX_PAGE + 1 };
    const { status, category } = args;
    const base = status && category
      ? ctx.db.query("supportTickets").withIndex("by_status_and_category_and_createdAt", (q) => q.eq("status", status).eq("category", category))
      : status
        ? ctx.db.query("supportTickets").withIndex("by_status_and_createdAt", (q) => q.eq("status", status))
        : category
          ? ctx.db.query("supportTickets").withIndex("by_category_and_createdAt", (q) => q.eq("category", category))
          : ctx.db.query("supportTickets").withIndex("by_createdAt");
    const result = await base.order("desc").paginate(opts);
    return { page: result.page.map(row), isDone: result.isDone, continueCursor: result.continueCursor };
  },
});

export const getTicket = query({
  args: { ticketId: v.id("supportTickets") },
  returns: v.union(
    v.null(),
    v.object({
      ticket: v.object({
        ...ticketRowValidator.fields,
        message: v.string(),
        userId: v.optional(v.string()),
        pagePath: v.optional(v.string()),
        userAgent: v.optional(v.string()),
        screenshotUrl: v.union(v.string(), v.null()),
        resolvedAt: v.optional(v.number()),
      }),
      notes: v.array(
        v.object({
          id: v.id("supportTicketNotes"),
          kind: v.union(v.literal("note"), v.literal("status")),
          actorId: v.string(),
          body: v.string(),
          createdAt: v.number(),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    await requireEnabledAdminPermission(ctx, ...READ);
    const ticket = await ctx.db.get(args.ticketId);
    if (!ticket) return null;
    const notes = await ctx.db
      .query("supportTicketNotes")
      .withIndex("by_ticketId_and_createdAt", (q) => q.eq("ticketId", ticket._id))
      .order("asc")
      .take(MAX_NOTES);
    return {
      ticket: {
        ...row(ticket),
        message: ticket.message,
        userId: ticket.userId,
        pagePath: ticket.pagePath,
        userAgent: ticket.userAgent,
        screenshotUrl: ticket.screenshotId ? await ctx.storage.getUrl(ticket.screenshotId) : null,
        resolvedAt: ticket.resolvedAt,
      },
      notes: notes.map((note) => ({ id: note._id, kind: note.kind, actorId: note.actorId, body: note.body, createdAt: note.createdAt })),
    };
  },
});

export const updateTicketStatus = mutation({
  args: { ticketId: v.id("supportTickets"), status: supportStatusValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, ...WRITE);
    const ticket = await ctx.db.get(args.ticketId);
    if (!ticket) throw new ConvexError("Message was not found");
    if (ticket.status === args.status) return null;
    const now = Date.now();
    const closed = args.status === "resolved" || args.status === "closed";
    await ctx.db.patch(ticket._id, {
      status: args.status,
      updatedAt: now,
      resolvedAt: closed ? (ticket.resolvedAt ?? now) : undefined,
    });
    await ctx.db.insert("supportTicketNotes", {
      ticketId: ticket._id,
      kind: "status",
      actorId: actor.userId,
      body: `Status changed from ${SUPPORT_STATUS_LABELS[ticket.status]} to ${SUPPORT_STATUS_LABELS[args.status]}`,
      createdAt: now,
    });
    await writeAudit(ctx, {
      actorId: actor.userId,
      actorRoles: actor.roles,
      action: "support_ticket.status_changed",
      targetType: "supportTicket",
      targetId: ticket._id,
      reason: TRIAGE_REASON,
      beforeSummary: JSON.stringify({ status: ticket.status }),
      afterSummary: JSON.stringify({ status: args.status }),
      outcome: "success",
    });
    return null;
  },
});

export const addTicketNote = mutation({
  args: { ticketId: v.id("supportTickets"), body: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, ...WRITE);
    const body = args.body.trim();
    if (body.length < 1 || body.length > SUPPORT_LIMITS.noteMax) {
      throw new ConvexError(`Notes must be between 1 and ${SUPPORT_LIMITS.noteMax} characters`);
    }
    const ticket = await ctx.db.get(args.ticketId);
    if (!ticket) throw new ConvexError("Message was not found");
    const now = Date.now();
    await ctx.db.insert("supportTicketNotes", { ticketId: ticket._id, kind: "note", actorId: actor.userId, body, createdAt: now });
    await ctx.db.patch(ticket._id, { updatedAt: now });
    await writeAudit(ctx, {
      actorId: actor.userId,
      actorRoles: actor.roles,
      action: "support_ticket.note_added",
      targetType: "supportTicket",
      targetId: ticket._id,
      reason: TRIAGE_REASON,
      afterSummary: JSON.stringify({ noteAdded: true }),
      outcome: "success",
    });
    return null;
  },
});
