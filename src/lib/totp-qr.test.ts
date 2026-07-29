import { describe, expect, it } from "vitest";
import { renderTotpQr } from "./totp-qr";

describe("renderTotpQr", () => {
  it("renders the authenticator URI locally as a PNG data URL", async () => {
    const dataUrl = await renderTotpQr(
      "otpauth://totp/Law%20of%20the%20Land:admin%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Law%20of%20the%20Land",
    );

    expect(dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(dataUrl.length).toBeGreaterThan(500);
  });

  it("refuses to encode a non-authenticator URL", async () => {
    await expect(renderTotpQr("https://example.com/secret")).rejects.toThrow(
      "Invalid authenticator setup URI",
    );
  });
});
