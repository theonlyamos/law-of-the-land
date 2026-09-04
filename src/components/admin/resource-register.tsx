type CatalogStatusValue =
  | "draft"
  | "enabled"
  | "active"
  | "repealed"
  | "archived"
  | "uploading"
  | "staging_processing"
  | "ready_for_review"
  | "approved"
  | "publishing"
  | "published"
  | "rejected"
  | "failed"
  | "superseded"
  | "unpublished";

const STATUS_LABELS: Record<CatalogStatusValue, string> = {
  draft: "Draft",
  enabled: "Enabled",
  active: "Active",
  repealed: "Repealed",
  archived: "Archived",
  uploading: "Uploading",
  staging_processing: "Staging processing",
  ready_for_review: "Ready for review",
  approved: "Approved",
  publishing: "Indexing",
  published: "Published",
  rejected: "Rejected",
  failed: "Failed",
  superseded: "Superseded",
  unpublished: "Unpublished",
};

export function CatalogStatus({ status }: { status: CatalogStatusValue }) {
  const emphasized = ["enabled", "active", "published", "approved"].includes(status);
  return (
    <span
      className={`inline-flex min-h-7 items-center border px-2.5 text-xs font-semibold uppercase tracking-[0.1em] ${
        emphasized
          ? "border-[oklch(51%_0.09_150)] bg-[oklch(93%_0.035_145)] text-[oklch(31%_0.07_150)]"
          : "border-[oklch(67%_0.04_67)] bg-[oklch(94%_0.025_75)] text-[oklch(38%_0.045_54)]"
      }`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

export type VersionHistoryItem = {
  id: string;
  versionNumber: number;
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  status: CatalogStatusValue;
  failureSummary?: string;
  createdAt: number;
};

const INDEXING_MESSAGE = "Gemini is indexing this document. You can leave this page; the status updates automatically.";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function VersionHistory({ versions }: { versions: readonly VersionHistoryItem[] }) {
  if (versions.length === 0) {
    return (
      <p role="status" className="border-y border-[oklch(74%_0.028_78)] px-5 py-9 text-sm text-[oklch(40%_0.035_252)]">
        No document versions have been recorded. Uploads remain unavailable until the catalog record is ready.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table aria-label="Document version history" className="w-full border-collapse text-left">
        <thead className="border-b-2 border-[oklch(35%_0.055_252)]">
          <tr className="text-xs uppercase tracking-[0.12em] text-[oklch(42%_0.04_252)]">
            <th className="px-4 py-3">Version</th>
            <th className="px-4 py-3">Original</th>
            <th className="px-4 py-3">Review state</th>
            <th className="px-4 py-3">Recorded</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[oklch(78%_0.025_78)]">
          {versions.map((version) => (
            <tr key={version.id}>
              <td className="px-4 py-4 align-top font-semibold">Version {version.versionNumber}</td>
              <td className="px-4 py-4 align-top">
                <span className="block font-medium">{version.filename}</span>
                <span className="mt-1 block text-xs text-[oklch(45%_0.03_252)]">
                  {version.mimeType} / {formatBytes(version.byteSize)} / SHA-256 {version.sha256.slice(0, 12)}...
                </span>
              </td>
              <td className="px-4 py-4 align-top">
                <CatalogStatus status={version.status} />
                {version.status === "publishing" && version.failureSummary ? (
                  <p className="mt-2 text-xs font-semibold uppercase tracking-[0.08em] text-[oklch(40%_0.11_45)]">Indexing needs review</p>
                ) : null}
                {version.failureSummary ? (
                  <p className="mt-2 max-w-[40ch] text-sm leading-5 text-[oklch(38%_0.055_35)]">{version.failureSummary}</p>
                ) : version.status === "publishing" ? (
                  <p className="mt-2 max-w-[40ch] text-sm leading-5 text-[oklch(40%_0.035_252)]">{INDEXING_MESSAGE}</p>
                ) : null}
              </td>
              <td className="px-4 py-4 align-top text-sm">
                <time dateTime={new Date(version.createdAt).toISOString()}>
                  {new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(version.createdAt)}
                </time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
