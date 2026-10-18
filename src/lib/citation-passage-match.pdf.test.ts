// @vitest-environment node
import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { matchCitationPassage, type CitationTextItem } from "./citation-passage-match";

describe("citation passage matching against real PDF.js extraction", () => {
  it("locates an exact multi-line fixture passage and rejects duplicate and image-only pages", async () => {
    const fixture = await PDFDocument.create();
    const font = await fixture.embedFont(StandardFonts.Helvetica);
    const first = fixture.addPage([400, 500]);
    first.drawText("Section 1. Rights", { x: 40, y: 440, size: 14, font });
    first.drawText("Every worker has", { x: 40, y: 400, size: 12, font });
    first.drawText("a right to fair conditions.", { x: 40, y: 380, size: 12, font });
    const duplicate = fixture.addPage([400, 500]);
    duplicate.drawText("A worker has rights.", { x: 40, y: 440, size: 12, font });
    duplicate.drawText("A worker has rights.", { x: 40, y: 400, size: 12, font });
    const imageOnly = fixture.addPage([400, 500]);
    imageOnly.drawRectangle({ x: 40, y: 300, width: 300, height: 100 });
    const loading = getDocument({ data: await fixture.save(), useSystemFonts: true });
    try {
      const document = await loading.promise;
      expect(document.numPages).toBe(3);
      const extract = async (pageNumber: number) => {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent({ disableNormalization: true });
        return content.items.filter((item): item is typeof item & CitationTextItem => "str" in item);
      };
      const items = await extract(1);
      const exact = matchCitationPassage(items, "Every worker has a right to fair conditions.");
      expect(exact.status).toBe("matched");
      expect(exact.ranges.map((range) => items[range.itemIndex].str.slice(range.start, range.end)).join(" "))
        .toBe("Every worker has a right to fair conditions.");
      expect(matchCitationPassage(items, "Every worker has a right to unfair conditions.").status).toBe("no-match");
      expect(matchCitationPassage(await extract(2), "A worker has rights.").status).toBe("ambiguous");
      expect(matchCitationPassage(await extract(3), "A worker has rights.").status).toBe("no-text");
    } finally {
      await loading.destroy();
    }
  });
});
