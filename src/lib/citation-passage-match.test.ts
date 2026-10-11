import { describe, expect, it } from "vitest";
import { matchCitationPassage } from "./citation-passage-match";

describe("matchCitationPassage", () => {
  it("maps the exact quoted substring to its original text item offsets", () => {
    expect(matchCitationPassage([{ str: "Section 1. A worker has rights. Next." }], "A worker has rights.")).toEqual({
      status: "matched",
      ranges: [{ itemIndex: 0, start: 11, end: 31 }],
    });
  });

  it("preserves offsets across text runs and line-break whitespace", () => {
    expect(matchCitationPassage([
      { str: "Before. Every  ", hasEOL: true },
      { str: "\tworker has", hasEOL: true },
      { str: "rights. After." },
    ], "Every worker has rights.")).toEqual({
      status: "matched",
      ranges: [
        { itemIndex: 0, start: 8, end: 15 },
        { itemIndex: 1, start: 0, end: 11 },
        { itemIndex: 2, start: 0, end: 7 },
      ],
    });
  });

  it("handles words split into multiple PDF text runs without inventing spaces", () => {
    expect(matchCitationPassage([{ str: "employ" }, { str: "ment law" }], "employment")).toEqual({
      status: "matched",
      ranges: [{ itemIndex: 0, start: 0, end: 6 }, { itemIndex: 1, start: 0, end: 4 }],
    });
  });

  it("maps common printed ligatures back to the whole original glyph", () => {
    expect(matchCitationPassage([{ str: "The oﬃce may ﬁle." }], "office may file.")).toEqual({
      status: "matched",
      ranges: [{ itemIndex: 0, start: 4, end: 17 }],
    });
  });

  it("normalizes ligatures and whitespace on both sides", () => {
    expect(matchCitationPassage([{ str: "An office\u00a0file." }], "  An oﬃce\nfile.  ").status).toBe("matched");
  });

  it.each([
    ["The worker may leave.", "The worker must leave."],
    ["The Worker may leave.", "The worker may leave."],
    ["The worker may leave;", "The worker may leave."],
    ["The worker may leave.", "worker rights"],
    ["The worker may leave.", "The worker … leave."],
    ["Section ①", "Section 1"],
    ["The co-\noperative", "The cooperative"],
  ])("does not turn %j into an approximate match for %j", (text, quote) => {
    expect(matchCitationPassage([{ str: text }], quote)).toEqual({ status: "no-match", ranges: [] });
  });

  it("does not claim one location when the same quote appears twice", () => {
    expect(matchCitationPassage([{ str: "A worker has rights. A worker has rights." }], "A worker has rights.")).toEqual({
      status: "ambiguous",
      ranges: [],
    });
  });

  it("does not match fragments inside words or a ligature", () => {
    expect(matchCitationPassage([{ str: "Action" }], "Act").status).toBe("no-match");
    expect(matchCitationPassage([{ str: "oﬃce" }], "fi").status).toBe("no-match");
    expect(matchCitationPassage([{ str: "ﬃ" }], "ff").status).toBe("no-match");
  });

  it("counts overlapping exact matches as ambiguous", () => {
    expect(matchCitationPassage([{ str: "a a a" }], "a a").status).toBe("ambiguous");
  });

  it("distinguishes an absent text layer from a missing quote", () => {
    expect(matchCitationPassage([], "A worker has rights.")).toEqual({ status: "no-text", ranges: [] });
    expect(matchCitationPassage([{ str: " \n " }], "A worker has rights.").status).toBe("no-text");
    expect(matchCitationPassage([{ str: "A worker has rights." }], " \t")).toEqual({ status: "no-match", ranges: [] });
  });

  it("keeps UTF-16 offsets correct before and inside a quote", () => {
    expect(matchCitationPassage([{ str: "⚖️ 😀 A right." }], "😀 A right.")).toEqual({
      status: "matched", ranges: [{ itemIndex: 0, start: 3, end: 14 }],
    });
  });
});
