import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { sendEmail } from "./lib/email";
import { SUPPORT_CATEGORY_SHORT_LABELS, supportReference } from "../shared/support";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function paragraphs(value: string): string {
  return escapeHtml(value).replaceAll(/\r?\n/g, "<br />");
}

/** Comma-separated list of admin inboxes that should hear about new messages. */
export function supportNotificationRecipients(value = process.env.SUPPORT_NOTIFICATION_EMAIL): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry));
}

/**
 * Emails the platform team about a new message and sends signed-in senders a
 * receipt.
 * Delivery is best effort: the message is already saved in the admin inbox,
 * so a missing email setup or a provider error never loses it.
 */
export const notifyNewTicket = internalAction({
  args: { ticketId: v.id("supportTickets") },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!process.env.RESEND_API_KEY) return null;
    const ticket = await ctx.runQuery(internal.support.getTicketForNotification, { ticketId: args.ticketId });
    if (!ticket) return null;

    const reference = supportReference(ticket.id);
    const category = SUPPORT_CATEGORY_SHORT_LABELS[ticket.category];
    const site = process.env.SITE_URL?.replace(/\/$/, "");
    const inboxLink = site
      ? `<p><a href="${escapeHtml(`${site}/admin/feedback/${ticket.id}`)}">Open it in the admin inbox</a></p>`
      : "";
    const sender = ticket.name ? `${escapeHtml(ticket.name)} &lt;${escapeHtml(ticket.email)}&gt;` : escapeHtml(ticket.email);

    const deliveries: Promise<void>[] = supportNotificationRecipients().map((to) =>
      sendEmail({
        to,
        subject: `[${category}] ${ticket.subject} (#${reference})`,
        html: [
          `<p><strong>New ${escapeHtml(category.toLowerCase())}</strong> from ${sender}${ticket.signedIn ? " (signed in)" : " (guest)"}.</p>`,
          `<p><strong>${escapeHtml(ticket.subject)}</strong></p>`,
          `<p>${paragraphs(ticket.message)}</p>`,
          ticket.pagePath ? `<p>Sent from page: ${escapeHtml(ticket.pagePath)}</p>` : "",
          ticket.hasScreenshot ? "<p>A screenshot is attached in the admin inbox.</p>" : "",
          inboxLink,
        ].join(""),
      }),
    );

    // Receipts go only to signed-in accounts. A guest could type anyone's
    // address, and the form must not become a way to email strangers.
    if (ticket.signedIn) deliveries.push(
      sendEmail({
        to: ticket.email,
        subject: `We received your message (#${reference})`,
        html: [
          `<p>Hi${ticket.name ? ` ${escapeHtml(ticket.name)}` : ""},</p>`,
          "<p>Thanks for contacting Law of the Land. We received your message and will reply to this email address.</p>",
          `<p>Your reference is <strong>#${reference}</strong>.</p>`,
          `<p><strong>${escapeHtml(ticket.subject)}</strong><br />${paragraphs(ticket.message)}</p>`,
        ].join(""),
      }),
    );

    const results = await Promise.allSettled(deliveries);
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed > 0) {
      // Recipients and message content are deliberately left out of logs.
      console.warn(`Support notification: ${failed} of ${results.length} emails were not delivered`);
    }
    return null;
  },
});
