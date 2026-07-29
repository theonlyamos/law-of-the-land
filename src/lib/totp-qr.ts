import QRCode from "qrcode";

export async function renderTotpQr(totpUri: string): Promise<string> {
  if (!totpUri.startsWith("otpauth://")) {
    throw new Error("Invalid authenticator setup URI");
  }

  return await QRCode.toDataURL(totpUri, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 256,
    color: {
      dark: "#172033",
      light: "#fffdf7",
    },
  });
}
