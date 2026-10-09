"use client";

import { useEffect, useState } from "react";
import { FileText, ImageIcon, RotateCcw, X } from "lucide-react";
import { chatAttachmentFormat, MAX_CHAT_FILES, type ChatAttachment } from "../../../shared/chat-attachments";
import type { DraftAttachment } from "./use-chat-attachments";

export function formatAttachmentSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function FilePreview({ file, src }: { file?: File; src?: string }) {
  const [localUrl, setLocalUrl] = useState<string>();
  const isImage = file ? chatAttachmentFormat(file.name, file.type)?.kind === "image" : false;
  useEffect(() => {
    if (!file || !isImage) return;
    const url = URL.createObjectURL(file);
    setLocalUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isImage]);
  const image = src ?? localUrl;
  return (
    <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-background text-primary">
      {image
        // Blob previews and authenticated file routes must not use the public image optimizer.
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={image} alt="" loading={file ? undefined : "lazy"} decoding="async" className="size-full object-cover" />
        : isImage ? <ImageIcon className="size-5" aria-hidden="true" /> : <FileText className="size-5" aria-hidden="true" />}
    </span>
  );
}

function Filename({ name }: { name: string }) {
  const dot = name.lastIndexOf(".");
  return (
    <span className="flex min-w-0 text-xs font-medium" title={name}>
      <span className="truncate">{dot > 0 ? name.slice(0, dot) : name}</span>
      {dot > 0 && <span className="shrink-0">{name.slice(dot)}</span>}
    </span>
  );
}

export function DraftAttachmentTray({ files, error, disabled, onRemove, onRetry }: {
  files: DraftAttachment[];
  error: string | null;
  disabled: boolean;
  onRemove: (file: DraftAttachment) => void;
  onRetry?: (file: DraftAttachment) => void;
}) {
  if (!files.length && !error) return null;
  return (
    <section aria-label="Attached files" className="border-b border-border/70 px-1 pb-3 pt-1">
      {files.length > 0 && <div className="mb-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <p>{files.length} of {MAX_CHAT_FILES} files</p><p>10 MB each · 25 MB total</p>
      </div>}
      {files.length > 0 && <ul className="grid max-h-[40dvh] min-w-0 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">
        {files.map((item) => (
          <li key={item.localId} className={`min-w-0 self-start rounded-lg border bg-secondary/40 ${item.state === "error" ? "border-destructive/45 dark:border-red-300/45" : "border-border/70"}`}>
            <div className="flex min-w-0 items-center gap-2 pl-2">
              <FilePreview file={item.file} />
              <div className="min-w-0 flex-1 py-2">
                <Filename name={item.file.name} />
                <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                  {item.file.name.split(".").pop()?.toUpperCase()} · {formatAttachmentSize(item.file.size)} · {item.state === "selected" ? "Ready to upload" : item.state === "ready" ? "Uploaded" : item.state === "removing" ? "Removing…" : item.state === "uploading" ? item.progress >= 100 ? "Checking file…" : `Uploading ${item.progress}%` : "Upload failed"}
                </p>
              </div>
              <button type="button" disabled={disabled || item.state === "uploading" || item.state === "removing"} onClick={() => onRemove(item)}
                aria-label={`Remove ${item.file.name}`} className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40">
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </div>
            {item.state === "uploading" && <div role="progressbar" aria-label={`Uploading ${item.file.name}`} aria-valuenow={item.progress} aria-valuemin={0} aria-valuemax={100} className="mx-2 mb-2 h-1 overflow-hidden rounded bg-border">
              <div className="h-full bg-primary transition-[width]" style={{ width: `${item.progress}%` }} />
            </div>}
            {item.state === "error" && <div className="px-2 pb-2">
              <p role="alert" className="text-xs leading-5 text-red-700 dark:text-red-300">{item.error}</p>
              {onRetry && <button type="button" disabled={disabled} onClick={() => onRetry?.(item)} aria-label={`Retry ${item.file.name}`} className="mt-1 inline-flex min-h-9 items-center gap-1.5 rounded text-xs font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40">
                <RotateCcw className="size-3" aria-hidden="true" />Retry upload
              </button>}
            </div>}
          </li>
        ))}
      </ul>}
      {error && <p role="alert" className="mt-2 text-xs leading-5 text-red-700 dark:text-red-300">{error}</p>}
      {files.length > 0 && <p className="mt-2 text-[11px] leading-4 text-muted-foreground">Files are private to this chat. Their contents are sent to our AI provider to answer your question.</p>}
    </section>
  );
}

export function MessageAttachments({ attachments }: { attachments?: ChatAttachment[] }) {
  if (!attachments?.length) return null;
  return (
    <section aria-label="Your files" className="mt-2 w-full min-w-0">
      <p className="mb-2 text-right text-[11px] text-muted-foreground">Your files · {attachments.length}</p>
      <ul className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
        {attachments.map((attachment) => {
          const url = `/api/chat/attachments/${encodeURIComponent(attachment.id)}`;
          return <li key={attachment.id} className="min-w-0">
            <a href={`${url}?download=1`} className="flex min-w-0 items-center gap-2 rounded-lg border border-border/70 bg-secondary/30 p-2 hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Download ${attachment.filename}`}>
              <FilePreview src={attachment.kind === "image" ? url : undefined} />
              <span className="min-w-0"><Filename name={attachment.filename} /><span className="mt-0.5 block text-[11px] text-muted-foreground">{formatAttachmentSize(attachment.byteSize)} · {attachment.filename.split(".").pop()?.toUpperCase()}</span></span>
            </a>
          </li>;
        })}
      </ul>
    </section>
  );
}
