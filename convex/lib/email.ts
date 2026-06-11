/**
 * Sends transactional email through Resend. Requires RESEND_API_KEY (and
 * optionally EMAIL_FROM) set on the Convex deployment. Without a key — e.g.
 * local dev — the message is logged to the Convex console instead so the
 * verification link stays reachable.
 */
export async function sendEmail(options: {
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    console.warn(
      `RESEND_API_KEY is not set — email to ${options.to} (“${options.subject}”) was not sent. Content:\n${options.html}`
    );
    return;
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
    const body = await response.text().catch(() => "");
    throw new Error(`Resend returned ${response.status}: ${body.slice(0, 300)}`);
  }
}
