"use client";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  computeFileSha256,
  validateDocumentFile,
} from "@/lib/admin/file-validation";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

const ACCEPTED_EXTENSIONS =
  ".txt,.docx,.pptx,.xlsx,.pdf,.png,.jpg,.csv,.tsv,.json";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type UploadState =
  | { kind: "idle" }
  | { kind: "busy"; message: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

export function DocumentUpload({
  resourceId,
  resourceStatus,
  defaultSourceUrl,
  defaultEffectiveAt,
  maxBytes,
}: {
  resourceId: string;
  resourceStatus: "active" | "repealed" | "archived";
  defaultSourceUrl: string;
  defaultEffectiveAt: string;
  maxBytes: number;
}) {
  const router = useRouter();
  const generateUploadUrl = useMutation(api.admin.documents.generateUploadUrl);
  const createDocumentVersion = useMutation(
    api.admin.documents.createDocumentVersion,
  );
  const [file, setFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState(defaultSourceUrl);
  const [effectiveAt, setEffectiveAt] = useState(defaultEffectiveAt);
  const [state, setState] = useState<UploadState>({ kind: "idle" });
  const busy = state.kind === "busy";

  if (resourceStatus !== "active") return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) {
      setState({ kind: "error", message: "Choose an original legal file." });
      return;
    }
    const validation = validateDocumentFile(file, maxBytes);
    if (!validation.ok) {
      setState({ kind: "error", message: validation.reason });
      return;
    }

    try {
      setState({ kind: "busy", message: "Computing file checksum..." });
      const sha256 = await computeFileSha256(file);
      const uploadUrl = await generateUploadUrl({});
      setState({ kind: "busy", message: "Uploading original to protected storage..." });
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!response.ok) {
        setState({
          kind: "error",
          message: "The original could not be uploaded. Try again.",
        });
        return;
      }
      const payload: unknown = await response.json();
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("storageId" in payload) ||
        typeof payload.storageId !== "string"
      ) {
        setState({
          kind: "error",
          message: "The storage service returned an invalid response.",
        });
        return;
      }

      setState({ kind: "busy", message: "Recording governed draft metadata..." });
      await createDocumentVersion({
        resourceId: resourceId as Id<"legalResources">,
        storageId: payload.storageId as Id<"_storage">,
        filename: file.name,
        mimeType: file.type,
        byteSize: file.size,
        sha256,
        sourceUrl,
        effectiveAt,
      });
      setFile(null);
      setState({
        kind: "success",
        message: "Draft version recorded. It is ready for staging preparation.",
      });
      router.refresh();
    } catch {
      setState({
        kind: "error",
        message: "The draft could not be recorded. Review the file and try again.",
      });
    }
  }

  return (
    <section
      aria-labelledby={`document-upload-${resourceId}`}
      className="border-y-2 border-[oklch(35%_0.055_252)] bg-[oklch(96%_0.018_78)] px-5 py-7 sm:px-7"
    >
      <div className="grid gap-7 lg:grid-cols-[minmax(0,0.7fr)_minmax(20rem,1.3fr)]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[oklch(43%_0.065_67)]">
            Original evidence
          </p>
          <h2
            id={`document-upload-${resourceId}`}
            className="mt-2 text-2xl font-semibold tracking-[-0.035em] text-[oklch(23%_0.05_252)]"
          >
            Add an original
          </h2>
          <p className="mt-3 max-w-[38ch] text-sm leading-6 text-[oklch(40%_0.035_252)]">
            The browser sends the file directly to protected Convex storage.
            A SHA-256 checksum binds the immutable original to its draft record.
          </p>
          <p className="mt-4 text-xs font-semibold uppercase tracking-[0.1em] text-[oklch(37%_0.05_252)]">
            PDF, Office, text, image, CSV, TSV, or JSON / {formatBytes(maxBytes)} maximum
          </p>
        </div>

        <form onSubmit={submit} className="grid gap-5" noValidate>
          <div>
            <label htmlFor={`document-file-${resourceId}`} className="text-sm font-semibold">
              Original legal file
            </label>
            <input
              id={`document-file-${resourceId}`}
              type="file"
              accept={ACCEPTED_EXTENSIONS}
              required
              disabled={busy}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setState({ kind: "idle" });
              }}
              className="mt-2 block min-h-11 w-full border border-[oklch(62%_0.035_70)] bg-[oklch(99%_0.01_82)] px-3 py-2 text-sm file:mr-4 file:border-0 file:border-r file:border-[oklch(62%_0.035_70)] file:bg-transparent file:pr-4 file:font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
            />
          </div>
          <div className="grid gap-5 sm:grid-cols-[minmax(0,1.35fr)_minmax(10rem,0.65fr)]">
            <div>
              <label htmlFor={`document-source-${resourceId}`} className="text-sm font-semibold">
                Official source URL
              </label>
              <input
                id={`document-source-${resourceId}`}
                type="url"
                value={sourceUrl}
                required
                disabled={busy}
                onChange={(event) => setSourceUrl(event.target.value)}
                className="mt-2 min-h-11 w-full border border-[oklch(62%_0.035_70)] bg-[oklch(99%_0.01_82)] px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
              />
            </div>
            <div>
              <label htmlFor={`document-effective-${resourceId}`} className="text-sm font-semibold">
                Effective date
              </label>
              <input
                id={`document-effective-${resourceId}`}
                type="date"
                value={effectiveAt}
                required
                disabled={busy}
                onChange={(event) => setEffectiveAt(event.target.value)}
                className="mt-2 min-h-11 w-full border border-[oklch(62%_0.035_70)] bg-[oklch(99%_0.01_82)] px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-4 border-t border-[oklch(74%_0.028_78)] pt-5">
            <button
              type="submit"
              disabled={busy}
              className="min-h-11 bg-[oklch(29%_0.05_252)] px-5 text-sm font-semibold text-[oklch(97%_0.012_78)] transition-colors hover:bg-[oklch(23%_0.05_252)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 disabled:cursor-wait disabled:opacity-60"
            >
              {busy ? "Upload in progress" : "Upload draft version"}
            </button>
            {state.kind !== "idle" ? (
              <p
                role={state.kind === "error" ? "alert" : "status"}
                aria-live="polite"
                className={`text-sm font-medium ${
                  state.kind === "error"
                    ? "text-[oklch(40%_0.16_28)]"
                    : "text-[oklch(32%_0.07_150)]"
                }`}
              >
                {state.message}
              </p>
            ) : null}
          </div>
        </form>
      </div>
    </section>
  );
}
