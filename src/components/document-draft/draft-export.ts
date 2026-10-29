import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { CLAUSE_BASIS_LABELS, NOT_SURE_SIDE, draftFileName } from "../../../shared/document-draft";
import type { ExportDocument, ExportOptions } from "@/lib/document-export/model";

export type DraftData = NonNullable<FunctionReturnType<typeof api.documentDrafts.get>>;
export type ExportFormat = "pdf" | "docx";

function sourceLabel(citation: { label: string; provision?: string }): string {
  return citation.provision ? `${citation.label}, ${citation.provision}` : citation.label;
}

/** The draft as the exporters read it. */
export function toExportDocument(data: DraftData, options: ExportOptions, preparedAt = Date.now()): ExportDocument {
  const { draft } = data;
  return {
    title: draft.title ?? "Document",
    documentType: draft.documentType ?? "Legal document",
    jurisdictionName: draft.jurisdictionName,
    ...(draft.roleLabel && draft.roleLabel !== NOT_SURE_SIDE.label ? { sideLabel: draft.roleLabel } : {}),
    audience: draft.audience ?? "personal",
    version: draft.version,
    preparedAt,
    clauses: data.clauses.map((clause) => ({
      kind: clause.kind,
      heading: clause.heading,
      text: clause.text,
      basisLabel: CLAUSE_BASIS_LABELS[clause.basis],
      why: clause.why,
      lawSummary: clause.lawSummary,
      sources: clause.citations.map(sourceLabel),
    })),
    formalities: data.formalities.map((item) => ({
      title: item.title,
      detail: item.detail,
      required: item.basis === "required",
      sources: item.citations.map(sourceLabel),
    })),
    options,
  };
}

/** Builds the file in the browser and saves it. The exporters load only when used. */
export async function exportDraft(data: DraftData, format: ExportFormat, options: ExportOptions): Promise<void> {
  const document = toExportDocument(data, options);
  const pdf = await import("@/lib/document-export/pdf");
  if (format === "docx") {
    const { buildDocx, DOCX_MIME } = await import("@/lib/document-export/docx");
    pdf.downloadFile(buildDocx(document), draftFileName(document.title, "docx"), DOCX_MIME);
    return;
  }
  const bytes = await pdf.buildPdf(document, await pdf.loadExportFonts(options.style));
  pdf.downloadFile(bytes, draftFileName(document.title, "pdf"), pdf.PDF_MIME);
}
