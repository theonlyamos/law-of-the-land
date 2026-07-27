import { afterEach, describe, expect, it, vi } from "vitest";
import { sendEmail } from "./email";

const previousResendApiKey = process.env.RESEND_API_KEY;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (previousResendApiKey === undefined) {
    delete process.env.RESEND_API_KEY;
  } else {
    process.env.RESEND_API_KEY = previousResendApiKey;
  }
});

describe("transactional email secret handling", () => {
  it("does not log recipients, raw links, or verification material in local mode", async () => {
    delete process.env.RESEND_API_KEY;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await sendEmail({
      to: "private-user@example.com",
      subject: "Verify your email",
      html: '<a href="https://example.com/verify?token=secret-value">Verify</a>',
    });

    expect(warn).toHaveBeenCalledOnce();
    const output = JSON.stringify(warn.mock.calls);
    expect(output).not.toContain("private-user@example.com");
    expect(output).not.toContain("https://");
    expect(output).not.toContain("secret-value");
  });

  it("does not expose provider response bodies in thrown errors", async () => {
    process.env.RESEND_API_KEY = "configured-for-test";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("provider-token=secret-provider-value", { status: 500 }),
      ),
    );

    await expect(
      sendEmail({
        to: "private-user@example.com",
        subject: "Verify your email",
        html: "<p>Verify</p>",
      }),
    ).rejects.not.toThrow("secret-provider-value");
  });
});
