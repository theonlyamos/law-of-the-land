"use client";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

type Version = {
  id: string;
  versionNumber: number;
  status: string;
  stagingDocumentId?: string;
};

export function DocumentStageRetry({ versions }: { versions: readonly Version[] }) {
  const router = useRouter();
  const stageDocumentVersion = useMutation(api.admin.documents.stageDocumentVersion);
  const [pendingVersionId, setPendingVersionId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const drafts = versions.filter(
    (version) => version.status === "draft" && version.stagingDocumentId === undefined,
  );

  async function stage(version: Version) {
    setPendingVersionId(version.id);
    setNotice("");
    setError("");
    try {
      await stageDocumentVersion({
        versionId: version.id as Id<"documentVersions">,
        reason: "Retry staging a recorded draft version",
        idempotencyKey: `restage-${version.id}-${crypto.randomUUID().replaceAll("-", "")}`,
      });
      setNotice(`Version ${version.versionNumber} was queued for GroundX staging.`);
      router.refresh();
    } catch {
      setError(`Version ${version.versionNumber} could not be queued for staging. Confirm the jurisdiction staging bucket is configured, then try again.`);
    } finally {
      setPendingVersionId(null);
    }
  }

  if (drafts.length === 0) return null;

  return (
    <section aria-label="Recorded draft recovery" className="mb-5 border-y border-[oklch(64%_0.09_45)] bg-[oklch(95%_0.035_55)] px-5 py-4">
      <p className="text-sm font-medium">A recorded draft is awaiting GroundX staging. Its original file is already protected in storage and does not need to be uploaded again.</p>
      <div className="mt-3 flex flex-wrap gap-3">
        {drafts.map((version) => (
          <button
            key={version.id}
            type="button"
            disabled={pendingVersionId !== null}
            onClick={() => void stage(version)}
            className="inline-flex min-h-11 items-center justify-center bg-[oklch(29%_0.05_252)] px-4 text-sm font-semibold text-[oklch(97%_0.012_78)] disabled:cursor-wait disabled:opacity-60"
          >
            {pendingVersionId === version.id ? "Staging version…" : `Stage version ${version.versionNumber}`}
          </button>
        ))}
      </div>
      {notice ? <p role="status" aria-live="polite" className="mt-3 text-sm text-[oklch(32%_0.07_150)]">{notice}</p> : null}
      {error ? <p role="alert" className="mt-3 text-sm text-[oklch(40%_0.16_28)]">{error}</p> : null}
    </section>
  );
}
