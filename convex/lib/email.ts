/**
 * Sends transactional email through Resend. Requires RESEND_API_KEY (and
 * optionally EMAIL_FROM) set on the Convex deployment. Recipients, message
 * bodies, provider responses, and verification links are never logged.
 */
export async function sendEmail(options: {
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    throw new Error("Transactional email delivery is not configured");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM ?? "Law of the Land <onboarding@resend.dev>",
      to: options.to,
      subject: options.subject,
      html: options.html,
    }),
  });

  if (!response.ok) {
    throw new Error(`Email provider returned status ${response.status}`);
  }
}
