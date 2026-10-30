import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalQuery, mutation, type MutationCtx } from "./_generated/server";
import { authComponent } from "./auth";
import { consumeRateBucket } from "./lib/rateBuckets";
import {
  SUPPORT_LIMITS,
  isAcceptableSupportScreenshot,
  isValidSupportEmail,
  normalizeSupportPagePath,
  supportReference,
} from "../shared/support";

const HOUR_MS = 60 * 60_000;

/** Per-person and whole-site caps that keep the inbox usable if someone floods it. */
export const SUPPORT_RATE_LIMITS = {
  perUserPerHour: 5,
  perGuestEmailPerHour: 3,
  allGuestsPerHour: 30,
  uploadsPerUserPerHour: 10,
} as const;

export const supportCategoryValidator = v.union(
  v.literal("bug"),
  v.literal("feature_request"),
  v.literal("complaint"),
  v.literal("support"),
  v.literal("other"),
);

export const supportStatusValidator = v.union(
  v.literal("new"),
  v.literal("in_progress"),
  v.literal("resolved"),
  v.literal("closed"),
);

function rateLimited(retryAfterSeconds: number): never {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  throw new ConvexError({
    code: "SUPPORT_RATE_LIMITED",
    message: `You've sent several messages recently. Please try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
  });
}

function invalid(message: string): never {
  throw new ConvexError({ code: "SUPPORT_INVALID", message });
}

function cleanText(value: string, field: string, min: number, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length < min) invalid(`Please add a little more detail to the ${field}.`);
  if (trimmed.length > max) invalid(`The ${field} is too long. Please keep it under ${max.toLocaleString("en-US")} characters.`);
  return trimmed;
}

async function acceptScreenshot(
  ctx: MutationCtx,
  screenshotId: Id<"_storage">,
): Promise<Id<"_storage">> {
  const file = await ctx.db.system.get("_storage", screenshotId);
  if (!file) invalid("The screenshot upload could not be found. Please attach it again.");
  if (!isAcceptableSupportScreenshot(file)) invalid("Screenshots must be PNG, JPEG, WebP or GIF images under 5 MB.");
  return screenshotId;
}

/** Signed-in users can attach one screenshot; guests send text only. */
export const generateScreenshotUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      throw new ConvexError({ code: "SUPPORT_AUTH_REQUIRED", message: "Sign in to attach a screenshot." });
    }
    const retry = await consumeRateBucket(ctx, "support-upload", user._id, SUPPORT_RATE_LIMITS.uploadsPerUserPerHour, HOUR_MS);
    if (retry) rateLimited(retry);
    return await ctx.storage.generateUploadUrl();
  },
});

export const submitTicket = mutation({
  args: {
    category: supportCategoryValidator,
    subject: v.string(),
    message: v.string(),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    pagePath: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    screenshotId: v.optional(v.id("_storage")),
    // Hidden form field. People never fill it in; simple bots do.
    website: v.optional(v.string()),
  },
  returns: v.object({ reference: v.string() }),
  handler: async (ctx, args) => {
    const user = await authComponent.safeGetAuthUser(ctx);

    if (args.website) {
      if (args.screenshotId) await ctx.storage.delete(args.screenshotId);
      return { reference: supportReference(crypto.randomUUID().replaceAll("-", "")) };
    }

    const subject = cleanText(args.subject, "subject", SUPPORT_LIMITS.subjectMin, SUPPORT_LIMITS.subjectMax);
    const message = cleanText(args.message, "message", SUPPORT_LIMITS.messageMin, SUPPORT_LIMITS.messageMax);

    let email: string;
    let name: string | undefined;
    if (user) {
      email = user.email;
      name = user.name?.trim().slice(0, SUPPORT_LIMITS.nameMax) || undefined;
      const retry = await consumeRateBucket(ctx, "support-user", user._id, SUPPORT_RATE_LIMITS.perUserPerHour, HOUR_MS);
      if (retry) rateLimited(retry);
    } else {
      email = (args.email ?? "").trim().toLowerCase();
      if (!isValidSupportEmail(email)) invalid("Please enter a valid email address so we can reply.");
      const providedName = args.name?.trim();
      if (providedName && providedName.length > SUPPORT_LIMITS.nameMax) invalid("Your name is too long.");
      name = providedName || undefined;
      if (args.screenshotId) invalid("Sign in to attach a screenshot.");
      const perEmail = await consumeRateBucket(ctx, "support-guest-email", email, SUPPORT_RATE_LIMITS.perGuestEmailPerHour, HOUR_MS);
      if (perEmail) rateLimited(perEmail);
      const allGuests = await consumeRateBucket(ctx, "support-guest", "all", SUPPORT_RATE_LIMITS.allGuestsPerHour, HOUR_MS);
      if (allGuests) rateLimited(allGuests);
    }

    const screenshotId = args.screenshotId ? await acceptScreenshot(ctx, args.screenshotId) : undefined;
    const userAgent = args.userAgent?.trim().slice(0, SUPPORT_LIMITS.userAgentMax) || undefined;
    const now = Date.now();
    const ticketId = await ctx.db.insert("supportTickets", {
      category: args.category,
      subject,
      message,
      status: "new",
      ...(user ? { userId: user._id } : {}),
      ...(name ? { name } : {}),
      email,
      ...(normalizeSupportPagePath(args.pagePath) ? { pagePath: normalizeSupportPagePath(args.pagePath) } : {}),
      ...(userAgent ? { userAgent } : {}),
      ...(screenshotId ? { screenshotId } : {}),
      createdAt: now,
      updatedAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.supportNotifications.notifyNewTicket, { ticketId });
    return { reference: supportReference(ticketId) };
  },
});

export const getTicketForNotification = internalQuery({
  args: { ticketId: v.id("supportTickets") },
  returns: v.union(
    v.null(),
    v.object({
      id: v.id("supportTickets"),
      category: supportCategoryValidator,
      subject: v.string(),
      message: v.string(),
      name: v.optional(v.string()),
      email: v.string(),
      signedIn: v.boolean(),
      pagePath: v.optional(v.string()),
      hasScreenshot: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const ticket = await ctx.db.get(args.ticketId);
    if (!ticket) return null;
    return {
      id: ticket._id,
      category: ticket.category,
      subject: ticket.subject,
      message: ticket.message,
      name: ticket.name,
      email: ticket.email,
      signedIn: ticket.userId !== undefined,
      pagePath: ticket.pagePath,
      hasScreenshot: ticket.screenshotId !== undefined,
    };
  },
});
