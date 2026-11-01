import { useEffect, useState } from "react";
import { DocumentReview, type ReviewItem } from "../../src/components/admin/document-review";
import { AdminPermissionProvider } from "../../src/components/admin/permission-boundary";

type SourceRecord = NonNullable<ReviewItem["sourceVerifications"]>[number];
type ReviewState = {
  approvals: Record<string, unknown>[];
  corrections: Record<string, unknown>[];
  status: ReviewItem["status"];
  decisions: ReviewItem["decisions"];
  history: SourceRecord[];
};
const reviewKey = "batch-import-fixture-review";

export function reviewSourceUrl() {
  return new URLSearchParams(window.location.search).get("reviewSource") === "reproduction"
    ? "https://example-lawfirm.test/decisions/fixture.pdf"
    : "https://judicial.gov.gh/decisions/fixture.pdf";
}

export function reviewState(): ReviewState {
  const saved = localStorage.getItem(reviewKey);
  if (saved) return JSON.parse(saved) as ReviewState;
  const corrected = new URLSearchParams(window.location.search).get("reviewStatus") === "approved";
  return {
    approvals: [], corrections: [], status: corrected ? "approved" : "ready_for_review",
    decisions: corrected ? [{ decision: "approve", reviewerId: "earlier-reviewer", reason: "Earlier review decision retained verbatim.", evaluationRunId: "fixture-prior-evaluation", createdAt: 1000 }] : [],
    history: corrected ? [{
      kind: "approval", assessment: "verified", sourceClass: "official_hosted", sourceUrl: reviewSourceUrl(),
      verificationNotes: "Earlier source assertion retained verbatim.", corroboratingUrls: [],
      completeOriginal: true, citationChecked: true, laterTreatmentChecked: true,
      createdAt: 1000, reviewerId: "earlier-reviewer", reason: "Earlier source verification record.",
    }] : [],
  };
}

export function recordReviewFixtureMutation(name: string, args: Record<string, unknown>) {
  const state = reviewState();
  const source = args.sourceVerification as Omit<SourceRecord, "kind" | "assessment" | "createdAt" | "reviewerId" | "reason">;
  if (name === "admin/reviews:approveVersion") {
    state.approvals.push(args);
    state.status = "approved";
    state.decisions.push({ decision: "approve", reviewerId: "fixture-reviewer", reason: String(args.reason), evaluationRunId: String(args.evaluationRunId), createdAt: Date.now() });
    state.history.unshift({ ...source, kind: "approval", assessment: "verified", createdAt: Date.now(), reviewerId: "fixture-reviewer", reason: String(args.reason) });
  } else if (name === "admin/sourceVerification:recordCorrection") {
    state.corrections.push(args);
    const assessment = args.assessment === "unresolved" ? "unresolved" : "verified";
    state.history.unshift({ ...source, kind: "correction", assessment, createdAt: Date.now(), reviewerId: "fixture-reviewer", reason: String(args.reason) });
    if (assessment === "unresolved" && state.status === "approved") state.status = "ready_for_review";
  } else {
    throw new Error(`Unexpected source-review fixture mutation: ${name}`);
  }
  localStorage.setItem(reviewKey, JSON.stringify(state));
  window.dispatchEvent(new Event("fixture-review-change"));
  return { versionId: "source-review-fixture", status: state.status, correlationId: "fixture-operation" };
}

export function ReviewFixture() {
  const [, setRevision] = useState(0);
  useEffect(() => {
    const update = () => setRevision((revision) => revision + 1);
    window.addEventListener("fixture-review-change", update);
    return () => window.removeEventListener("fixture-review-change", update);
  }, []);
  const state = reviewState();
  const sourceUrl = reviewSourceUrl();
  const reproduction = new URLSearchParams(window.location.search).get("reviewSource") === "reproduction";
  const item: ReviewItem = {
    id: "source-review-fixture", resourceTitle: "Fixture Ghana judgment", officialCitation: "[2020] GHASC 17",
    versionNumber: 1, filename: "fixture-judgment.pdf", mimeType: "application/pdf", byteSize: 1200,
    sha256: "a".repeat(64), sourceHost: new URL(sourceUrl).hostname, sourceUrl,
    sourceProvenance: reproduction ? "Court text reproduced by a law firm. Government hosting and certification are not asserted." : "Court-hosted judgment, awaiting individual source verification.",
    requiresSourceVerification: true, status: state.status, submittedBy: "fixture-uploader",
    decisions: state.decisions, sourceVerifications: state.history,
  };
  return <AdminPermissionProvider permissions={["document:review", "document:publish"]}>
    <DocumentReview items={[item]} />
  </AdminPermissionProvider>;
}
