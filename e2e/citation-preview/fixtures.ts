import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";

export const EXACT_QUOTE = "Every worker has the right to fair notice before dismissal.";
export const NEXT_QUOTE = "The employer must provide a written explanation.";

/** Synthetic original documents. No user data or live document URLs. */
export async function citationPdfFixture(kind: "text" | "scan" | "duplicate" | "rotated" = "text"): Promise<Buffer> {
  const document = await PDFDocument.create();
  document.setTitle("Employment Rights Act — browser test fixture");
  const font = await document.embedFont(StandardFonts.Helvetica);
  if (kind === "scan") {
    const page = document.addPage([612, 792]);
    // An embedded raster image deliberately has no extractable text layer.
    const pixel = await document.embedPng(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    page.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: rgb(1, 1, 1) });
    for (let row = 0; row < 16; row++) {
      page.drawImage(pixel, { x: 54, y: 680 - row * 24, width: 440 - (row % 3) * 45, height: 6 });
    }
  } else if (kind === "duplicate") {
    const page = document.addPage([612, 792]);
    page.drawText(`${EXACT_QUOTE}\n\n${EXACT_QUOTE}`, { x: 48, y: 704, size: 12, lineHeight: 22, font });
  } else {
    const texts = [
      "EMPLOYMENT RIGHTS ACT\n\nSection 1. Purpose and application.\nThis synthetic legal document is used only for browser testing.\n\nThe following pages set out notice and explanation requirements.",
      `SECTION 2 — NOTICE\n\nBefore dismissal, notice requirements apply.\n${EXACT_QUOTE}\nAn exception may apply under the terms of the Act.\n\nThis surrounding text must remain visible around the quotation.`,
      `SECTION 3 — WRITTEN REASONS\n\n${NEXT_QUOTE}\nA copy should be retained with the employee record.`,
    ];
    for (let index = 0; index < texts.length; index++) {
      const page = document.addPage([612, 792]);
      if (kind === "rotated") page.setRotation(degrees(90));
      page.drawText(texts[index].replaceAll("—", "-"), { x: 48, y: 720, size: 12, lineHeight: 24, font, color: rgb(0.1, 0.12, 0.17) });
      page.drawText(`Page ${index + 1}`, { x: 48, y: 40, size: 10, font });
    }
  }
  return Buffer.from(await document.save());
}
