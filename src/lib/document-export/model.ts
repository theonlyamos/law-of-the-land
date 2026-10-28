import { PLACEHOLDER_PATTERN, type DraftAudience } from "../../../shared/document-draft";

export type ExportStyle = "modern" | "classic";
export type ExportPaper = "a4" | "letter";
export type ExportSectionKind = "opening" | "clause" | "schedule" | "signatures";

export type ExportClause = {
  kind: ExportSectionKind;
  heading: string;
  text: string;
  basisLabel: string;
  why: string;
  lawSummary: string;
  sources: string[];
};

export type ExportFormality = { title: string; detail: string; required: boolean; sources: string[] };

export type ExportOptions = {
  includeCover: boolean;
  includeNotes: boolean;
  style: ExportStyle;
  paper: ExportPaper;
  /** A light "Draft" mark on every page of the document. */
  watermark: boolean;
};

export type ExportDocument = {
  title: string;
  documentType: string;
  jurisdictionName: string;
  sideLabel?: string;
  audience: DraftAudience;
  version: number;
  preparedAt: number;
  clauses: ExportClause[];
  formalities: ExportFormality[];
  options: ExportOptions;
};

export type NumberedClause = ExportClause & { label: string };

/** Operative clauses are numbered 1, 2, 3; schedules are "Schedule 1"; the opening and signatures carry no number. */
export function numberClauses(clauses: readonly ExportClause[]): NumberedClause[] {
  let clause = 0;
  let schedule = 0;
  return clauses.map((entry) => {
    if (entry.kind === "clause") return { ...entry, label: `${++clause}.` };
    if (entry.kind === "schedule") return { ...entry, label: `Schedule ${++schedule}` };
    return { ...entry, label: "" };
  });
}

/** The visible heading line for a clause, such as "3. Rent and advance". */
export function clauseHeadingLine(clause: NumberedClause): string {
  if (!clause.label) return clause.heading;
  if (clause.kind === "schedule") return clause.heading && !/^schedule\b/iu.test(clause.heading) ? `${clause.label}: ${clause.heading}` : clause.label;
  return `${clause.label} ${clause.heading}`;
}

export type TextRun = { text: string; placeholder: boolean };

/** Splits text into plain runs and [blank] runs, which are highlighted so they are easy to fill in. */
export function textRuns(text: string): TextRun[] {
  const runs: TextRun[] = [];
  let last = 0;
  for (const match of text.matchAll(new RegExp(PLACEHOLDER_PATTERN.source, "gu"))) {
    const index = match.index ?? 0;
    if (index > last) runs.push({ text: text.slice(last, index), placeholder: false });
    runs.push({ text: match[0], placeholder: true });
    last = index + match[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), placeholder: false });
  return runs;
}

/** Paragraphs of a clause; sub-clauses such as "(a) …" are indented. */
export function clauseParagraphs(text: string): { text: string; indent: boolean }[] {
  return text.split(/\n+/u).map((line) => line.trim()).filter(Boolean)
    .map((line) => ({ text: line, indent: /^\((?:[a-z]{1,3}|[0-9]{1,3}|[ivxlc]{1,6})\)\s/iu.test(line) }));
}

export function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

export function coverNotice(document: Pick<ExportDocument, "jurisdictionName" | "preparedAt" | "audience">): string {
  const date = formatDate(document.preparedAt);
  return document.audience === "professional"
    ? `This draft was prepared with Law of the Land from the ${document.jurisdictionName} laws in its library as of ${date}. It is a working draft for professional review. Check every clause, the current law and the facts before it is used.`
    : `This document was prepared with Law of the Land using the ${document.jurisdictionName} laws in its library as of ${date}. It is a starting point, not legal advice, and Law of the Land is not a law firm. Read every clause and make sure it matches what has been agreed. For anything important or unusual, ask a lawyer to review it.`;
}

export const COVER_EYEBROW = "COVER PAGE · YOU CAN REMOVE THIS PAGE BEFORE SIGNING";

export function footerLine(document: Pick<ExportDocument, "version" | "preparedAt">): string {
  return `Version ${document.version} · ${formatDate(document.preparedAt)}`;
}

export function metaLine(document: Pick<ExportDocument, "documentType" | "jurisdictionName" | "sideLabel" | "version" | "preparedAt">): string {
  return [document.sideLabel ? `Prepared for: ${document.sideLabel}` : document.documentType, document.jurisdictionName,
    `Version ${document.version}`, formatDate(document.preparedAt)].join(" · ");
}
