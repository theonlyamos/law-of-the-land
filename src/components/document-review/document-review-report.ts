import {
  FINDING_STATUSES,
  FINDING_STATUS_DESCRIPTIONS,
  FINDING_STATUS_LABELS,
  FINDING_STATUS_ORDER,
  NOT_SURE_ROLE,
  countFindings,
  sortFindings,
  type DocumentReviewFinding,
  type DocumentReviewSegment,
  type FindingStatus,
} from "../../../shared/document-review";

export type DocumentReviewReportInput = {
  filename: string;
  documentType?: string;
  title?: string;
  roleLabel?: string;
  focusLabels: string[];
  jurisdictionName: string;
  headline?: string;
  overview?: string;
  nextSteps: string[];
  partialCoverage: boolean;
  completedAt?: number;
  segments: DocumentReviewSegment[];
  findings: DocumentReviewFinding[];
};

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ESCAPES[character]!);
}

const STATUS_COLOURS: Record<FindingStatus, { fg: string; bg: string }> = {
  attention: { fg: "#991b1b", bg: "#fef2f2" },
  check: { fg: "#92400e", bg: "#fffbeb" },
  fine: { fg: "#166534", bg: "#f0fdf4" },
  unconfirmed: { fg: "#374151", bg: "#f3f4f6" },
};

function badge(status: FindingStatus): string {
  const colour = STATUS_COLOURS[status];
  return `<span class="badge" style="color:${colour.fg};background:${colour.bg}">${escapeHtml(FINDING_STATUS_LABELS[status])}</span>`;
}

function findingHtml(finding: DocumentReviewFinding, segment: DocumentReviewSegment | undefined): string {
  const where = finding.kind === "missing" ? "Missing from the document" : segment?.ref ? `Part ${segment.ref}` : segment?.heading ?? "";
  const citations = finding.citations.length
    ? `<ul class="sources">${finding.citations.map((citation) => `<li>${escapeHtml(citation.label)}${citation.provision ? `, ${escapeHtml(citation.provision)}` : ""}${citation.pageNumber ? ` (page ${citation.pageNumber})` : ""} · ${escapeHtml(citation.jurisdictionName)}</li>`).join("")}</ul>`
    : "";
  return `<article class="finding">
  <header><span class="where">${escapeHtml(where)}</span>${badge(finding.status)}</header>
  <h3>${escapeHtml(finding.title)}</h3>
  ${segment && finding.kind === "passage" ? `<blockquote>${escapeHtml(segment.text)}</blockquote>` : ""}
  <p>${escapeHtml(finding.meaning)}</p>
  <div class="law"><strong>The law</strong><p>${escapeHtml(finding.lawSummary)}</p>${citations}</div>
  <p><strong>What to do:</strong> ${escapeHtml(finding.recommendation)}</p>
  ${finding.suggestedWording ? `<div class="wording"><strong>Suggested wording</strong><p>${escapeHtml(finding.suggestedWording)}</p></div>` : ""}
</article>`;
}

/** A standalone, printable HTML report of a completed review. */
export function buildDocumentReviewReport(input: DocumentReviewReportInput): string {
  const segments = new Map(input.segments.map((segment) => [segment.ordinal, segment]));
  const counts = countFindings(input.findings);
  const ordered = sortFindings(input.findings, "severity");
  const meta = [
    input.documentType,
    input.roleLabel && input.roleLabel !== NOT_SURE_ROLE.label ? `Reviewed for: ${input.roleLabel}` : undefined,
    input.jurisdictionName,
    input.completedAt ? new Date(input.completedAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : undefined,
  ].filter(Boolean).map((part) => escapeHtml(part!)).join(" · ");
  const sections = [...FINDING_STATUSES].sort((left, right) => FINDING_STATUS_ORDER[left] - FINDING_STATUS_ORDER[right])
    .filter((status) => counts[status] > 0)
    .map((status) => `<section>
  <h2>${escapeHtml(FINDING_STATUS_LABELS[status])} <span class="count">${counts[status]}</span></h2>
  <p class="hint">${escapeHtml(FINDING_STATUS_DESCRIPTIONS[status])}</p>
  ${ordered.filter((finding) => finding.status === status).map((finding) => findingHtml(finding, finding.segmentOrdinal === undefined ? undefined : segments.get(finding.segmentOrdinal))).join("\n")}
</section>`).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(`Review of ${input.filename}`)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.6 "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #111827; background: #fff; }
  main { max-width: 760px; margin: 0 auto; padding: 40px 24px 56px; }
  .eyebrow { margin: 0; font-size: 12px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: #6b7280; }
  h1 { margin: 6px 0 4px; font-size: 24px; line-height: 1.25; letter-spacing: -.01em; }
  .meta { margin: 0 0 24px; color: #4b5563; font-size: 13px; }
  .summary { padding: 18px 20px; border: 1px solid #e5e7eb; border-radius: 10px; margin-bottom: 28px; }
  .summary h2 { margin: 0 0 6px; font-size: 16px; }
  .summary ul { margin: 8px 0 0; padding-left: 20px; }
  .counts { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 0; padding: 0; list-style: none; }
  .badge { display: inline-flex; align-items: center; height: 22px; padding: 0 9px; border-radius: 999px; font-size: 12px; font-weight: 500; white-space: nowrap; }
  section > h2 { margin: 28px 0 2px; font-size: 17px; }
  .count { color: #6b7280; font-weight: 500; }
  .hint { margin: 0 0 12px; color: #6b7280; font-size: 13px; }
  .finding { padding: 16px 0; border-top: 1px solid #e5e7eb; break-inside: avoid; }
  .finding header { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
  .where { font: 500 12px "Geist Mono", ui-monospace, monospace; color: #4b5563; }
  .finding h3 { margin: 6px 0 8px; font-size: 15px; }
  .finding p { margin: 0 0 8px; }
  blockquote { margin: 0 0 10px; padding: 8px 12px; border-left: 3px solid #d1d5db; color: #374151; background: #f9fafb; white-space: pre-wrap; }
  .law, .wording { margin: 0 0 10px; padding: 10px 12px; border-radius: 8px; background: #f9fafb; }
  .law strong, .wording strong { display: block; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: #4b5563; }
  .law p, .wording p { margin: 4px 0 0; }
  .wording p { white-space: pre-wrap; }
  .sources { margin: 6px 0 0; padding-left: 18px; color: #374151; font-size: 13px; }
  .notice { margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e7eb; color: #6b7280; font-size: 12px; }
  @media print { main { padding: 0; } a { color: inherit; } }
</style>
</head>
<body>
<main>
  <p class="eyebrow">Document review · Law of the Land</p>
  <h1>${escapeHtml(input.title || input.filename)}</h1>
  <p class="meta">${escapeHtml(input.filename)}${meta ? ` · ${meta}` : ""}</p>
  <div class="summary">
    <h2>${escapeHtml(input.headline ?? "Summary")}</h2>
    ${input.overview ? `<p>${escapeHtml(input.overview)}</p>` : ""}
    ${input.nextSteps.length ? `<strong>Next steps</strong><ul>${input.nextSteps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ul>` : ""}
    <ul class="counts">${FINDING_STATUSES.filter((status) => counts[status] > 0).map((status) => `<li>${badge(status)} ${counts[status]}</li>`).join("")}</ul>
    ${input.focusLabels.length ? `<p class="hint" style="margin-top:10px">Focus areas: ${escapeHtml(input.focusLabels.join(", "))}</p>` : ""}
    ${input.partialCoverage ? `<p class="hint" style="margin-top:10px">Some sources for this jurisdiction were unavailable during the review, so coverage may be incomplete.</p>` : ""}
  </div>
  ${sections || "<p>No findings were recorded for this document.</p>"}
  <p class="notice">This review compares the document with the laws in the Law of the Land library. It is general legal information, not legal advice. For decisions with serious consequences, speak to a qualified lawyer.</p>
</main>
</body>
</html>`;
}

/** Opens the system print dialog for the report, where it can also be saved as a PDF. */
export function printDocumentReviewReport(html: string): boolean {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  document.body.appendChild(frame);
  const view = frame.contentWindow;
  if (!view) { frame.remove(); return false; }
  view.document.open();
  view.document.write(html);
  view.document.close();
  const cleanup = () => window.setTimeout(() => frame.remove(), 1_000);
  view.addEventListener("afterprint", cleanup, { once: true });
  window.setTimeout(() => {
    try { view.focus(); view.print(); } catch { cleanup(); }
    // Some browsers never fire afterprint for iframes.
    window.setTimeout(() => frame.isConnected && frame.remove(), 60_000);
  }, 50);
  return true;
}

/** Saves the report as a standalone HTML file. */
export function downloadDocumentReviewReport(html: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${filename.replace(/\.[^.]+$/u, "").replace(/[^\w.-]+/gu, " ").trim() || "document"} - review.html`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
