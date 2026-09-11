"use client";
import Link from "next/link";
import { useState } from "react";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { organizationApi } from "@/lib/organization-api";
import type { FunctionReturnType } from "convex/server";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { DocumentUpload } from "@/components/admin/document-upload";
import {
  DocumentReview,
  type ReviewItem,
} from "@/components/admin/document-review";
import { VersionHistory } from "@/components/admin/resource-register";

import { fieldClass as inputClass } from "@/components/admin/form-styles";
export function OrganizationResources({
  organizationId,
  jurisdictionId,
}: {
  organizationId: Id<"organizations">;
  jurisdictionId: Id<"jurisdictions">;
}) {
  const workspace = useQuery(organizationApi.organizationJurisdictions.get, {
    organizationId,
    jurisdictionId,
  });
  const { results, status, loadMore } = usePaginatedQuery(
    organizationApi.organizationContent.listResources,
    { organizationId, jurisdictionId },
    { initialNumItems: 20 },
  );
  const create = useMutation(
    organizationApi.organizationContent.createResource,
  );
  const [creating, setCreating] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold">Documents</h1>
        {workspace?.canManage &&
          workspace.jurisdiction.status !== "archived" && (
            <Button onClick={() => setCreating((v) => !v)}>
              {creating ? "Cancel" : "Add document"}
            </Button>
          )}
      </header>
      <p className="text-sm text-muted-foreground">
        Create a document record and upload the original. Owners can review and
        publish their own uploads, or invite a reviewer.
      </p>
      {workspace?.jurisdiction.status === "draft" && (
        <p role="status" className="border p-4 text-sm">
          {workspace.jurisdiction.libraryState === "ready"
            ? "Your library is ready. Enable this jurisdiction before publishing documents."
            : "Your library is being set up. You can add documents while setup completes."}{" "}
          <Link
            className="font-semibold underline"
            href={`/organizations/${organizationId}/jurisdictions/${jurisdictionId}/settings`}
          >
            Library settings
          </Link>
        </p>
      )}
      {creating && (
        <form
          className="grid gap-4 rounded-none border p-5 sm:grid-cols-2"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!workspace?.jurisdiction) return;
            const form = new FormData(event.currentTarget);
            const text = (name: string) => String(form.get(name) ?? "");
            setBusy(true);
            setError("");
            try {
              await create({
                jurisdictionId: workspace.jurisdiction.id,
                type: text("type"),
                title: text("title"),
                issuer: text("issuer"),
                officialCitation: text("officialCitation"),
                sourceUrl: text("sourceUrl"),
                effectiveDate: text("effectiveDate"),
                topics: [],
                reason: text("reason"),
              });
              setCreating(false);
            } catch {
              setError(
                "The document couldn't be created. Check required fields and ensure its citation is unique.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          {[
            ["title", "Document title"],
            ["issuer", "Issuing organization"],
            ["officialCitation", "Official citation or reference"],
            ["sourceUrl", "Official source URL"],
            ["effectiveDate", "Effective date"],
            ["reason", "Reason for adding"],
          ].map(([name, label]) => (
            <label key={name} className="grid gap-2 text-sm font-medium">
              {label}
              <input
                name={name}
                required
                maxLength={name === "sourceUrl" ? 500 : 300}
                minLength={name === "reason" ? 3 : undefined}
                type={
                  name === "effectiveDate"
                    ? "date"
                    : name === "sourceUrl"
                      ? "url"
                      : "text"
                }
                className={inputClass}
              />
            </label>
          ))}
          <label className="grid gap-2 text-sm font-medium">
            Document type
            <select name="type" defaultValue="policy" className={inputClass}>
              {[
                "constitution",
                "act",
                "regulation",
                "ordinance",
                "judgment",
                "policy",
                "guidance",
              ].map((type) => (
                <option key={type}>{type}</option>
              ))}
            </select>
          </label>
          <Button disabled={busy} className="self-end">
            {busy ? "Creating…" : "Create document"}
          </Button>
          {error && <p role="alert">{error}</p>}
        </form>
      )}
      <ul className="divide-y rounded-none border">
        {results.map((resource) => (
          <li key={resource._id} className="p-4">
            <Link
              href={`/organizations/${organizationId}/jurisdictions/${jurisdictionId}/resources/${resource._id}`}
              className="font-medium underline underline-offset-4"
            >
              {resource.title}
            </Link>
            <p className="mt-1 text-sm text-muted-foreground">
              {resource.officialCitation} · {resource.status}
              {resource.activeVersionId ? " · Published" : " · Not published"}
            </p>
          </li>
        ))}
      </ul>
      {status === "LoadingFirstPage" ? (
        <p role="status">Loading documents…</p>
      ) : !results.length ? (
        <p>No documents yet.</p>
      ) : null}
      {status === "CanLoadMore" && (
        <Button variant="outline" onClick={() => loadMore(20)}>
          Load more
        </Button>
      )}
    </div>
  );
}
export function OrganizationDocument({
  organizationId,
  jurisdictionId,
  resourceId,
}: {
  organizationId: Id<"organizations">;
  jurisdictionId: Id<"jurisdictions">;
  resourceId: Id<"legalResources">;
}) {
  const detail = useQuery(organizationApi.organizationContent.getResource, {
    organizationId,
    jurisdictionId,
    resourceId,
  });
  const { results, status, loadMore } = usePaginatedQuery(
    organizationApi.organizationContent.listVersions,
    { organizationId, jurisdictionId, resourceId },
    { initialNumItems: 10 },
  );
  const approve = useMutation(
      organizationApi.organizationContent.approveVersion,
    ),
    reject = useMutation(organizationApi.organizationContent.rejectVersion),
    publish = useMutation(organizationApi.organizationContent.publishVersion),
    unpublish = useMutation(
      organizationApi.organizationContent.unpublishVersion,
    ),
    rollback = useMutation(organizationApi.organizationContent.rollbackVersion);
  if (!detail) return <p role="status">Loading document…</p>;
  const resource = detail.resource;
  const items: ReviewItem[] = results.flatMap((row) => {
    const status = row.status;
    return status === "ready_for_review" ||
      status === "approved" ||
      status === "publishing" ||
      status === "published" ||
      status === "superseded"
      ? [{ ...row, status }]
      : [];
  });
  return (
    <div className="space-y-8">
      <header>
        <Link
          href={`/organizations/${organizationId}/jurisdictions/${jurisdictionId}/resources`}
          className="text-sm underline"
        >
          Documents
        </Link>
        <h1 className="mt-4 text-3xl font-semibold">{resource.title}</h1>
        <p className="mt-2 text-muted-foreground">
          {resource.officialCitation}
        </p>
      </header>
      {detail.canManage && (
        <DocumentUpload
          resourceId={resourceId}
          resourceStatus={resource.status}
          defaultSourceUrl={resource.sourceUrl}
          defaultEffectiveAt={resource.effectiveDate}
          maxBytes={detail.maxBytes}
          onUpload={async (input) => {
            const form = new FormData();
            form.set("file", input.file);
            form.set("sourceUrl", input.sourceUrl);
            form.set("effectiveAt", input.effectiveAt);
            const response = await fetch(
              `/api/organizations/${organizationId}/resources/${resourceId}/upload`,
              {
                method: "POST",
                body: form,
                signal: AbortSignal.timeout(60000),
              },
            );
            if (!response.ok) throw new Error("Upload could not be confirmed.");
          }}
        />
      )}
      {detail.canManage && <ResourceSettings resource={resource} />}
      <section className="rounded-none bg-[oklch(97%_0.012_82)] p-5 text-[oklch(23%_0.05_252)]">
        <h2 className="mb-4 text-xl font-semibold">Version history</h2>
        <VersionHistory versions={results} />
        {results
          .filter(
            (row) => row.status === "publishing" || row.status === "published",
          )
          .map((row) => (
            <PublicationStatus key={row.id} versionId={row.id} />
          ))}
        {status === "CanLoadMore" && (
          <Button variant="outline" onClick={() => loadMore(10)}>
            Load more versions
          </Button>
        )}
      </section>
      <section className="rounded-none bg-[oklch(97%_0.012_82)] p-5 text-[oklch(23%_0.05_252)]">
        <DocumentReview
          items={items}
          actions={{ approve, reject, publish, unpublish, rollback }}
          canReview={detail.canReview}
          operationsHref={`/organizations/${organizationId}/jurisdictions/${jurisdictionId}/resources/${resourceId}`}
        />
      </section>
    </div>
  );
}
function PublicationStatus({
  versionId,
}: {
  versionId: Id<"documentVersions">;
}) {
  const job = useQuery(organizationApi.organizationContent.publicationStatus, {
    versionId,
  });
  const retry = useMutation(
    organizationApi.organizationContent.retryPublication,
  );
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  if (!job) return null;
  return (
    <div className="space-y-2 rounded border p-3 text-sm">
      <p>Publication: {job.status.replaceAll("_", " ")}</p>
      {job.canRetry && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await retry({
                jobId: job.id,
                reason: "Resume known publication operation",
                idempotencyKey: `retry_${crypto.randomUUID()}`,
              });
              setMessage("Publication check resumed.");
            } catch {
              setMessage(
                "This operation couldn't be resumed safely. Contact your platform administrator.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          Retry safely
        </Button>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}

function ResourceSettings({
  resource,
}: {
  resource: FunctionReturnType<
    typeof organizationApi.organizationContent.getResource
  >["resource"];
}) {
  const update = useMutation(
      organizationApi.organizationContent.updateResource,
    ),
    archive = useMutation(organizationApi.organizationContent.archiveResource);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  if (resource.status === "archived") return null;
  return (
    <details className="rounded-none border p-4">
      <summary className="cursor-pointer font-medium">
        Edit document details
      </summary>
      <form
        className="mt-4 grid gap-4 sm:grid-cols-2"
        onSubmit={async (event) => {
          event.preventDefault();
          const f = new FormData(event.currentTarget),
            value = (name: string) => String(f.get(name) ?? "");
          const action = (
            event.nativeEvent as SubmitEvent
          ).submitter?.getAttribute("value");
          setBusy(true);
          try {
            if (action === "archive")
              await archive({ id: resource._id, reason: value("reason") });
            else
              await update({
                id: resource._id,
                title: value("title"),
                issuer: value("issuer"),
                officialCitation: value("officialCitation"),
                sourceUrl: value("sourceUrl"),
                effectiveDate: value("effectiveDate"),
                topics: resource.topics,
                reason: value("reason"),
              });
            setMessage(
              action === "archive" ? "Document archived." : "Document updated.",
            );
          } catch {
            setMessage(
              "The change couldn't be saved. Check the fields and ensure publication is finished. Published documents must be unpublished before archiving.",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {[
          ["title", "Title", resource.title],
          ["issuer", "Issuing organization", resource.issuer],
          [
            "officialCitation",
            "Official citation or reference",
            resource.officialCitation,
          ],
          ["sourceUrl", "Official source URL", resource.sourceUrl],
          ["effectiveDate", "Effective date", resource.effectiveDate],
          ["reason", "Reason for change", ""],
        ].map(([name, label, value]) => (
          <label key={name} className="grid gap-2 text-sm font-medium">
            {label}
            <input
              className={inputClass}
              name={name}
              type={
                name === "effectiveDate"
                  ? "date"
                  : name === "sourceUrl"
                    ? "url"
                    : "text"
              }
              defaultValue={value}
              required
              minLength={name === "reason" ? 3 : undefined}
              maxLength={500}
            />
          </label>
        ))}
        <div className="flex flex-wrap gap-3">
          <Button disabled={busy} value="save">
            Save document
          </Button>
          <Button
            disabled={busy || !!resource.activeVersionId}
            variant="outline"
            value="archive"
          >
            Archive document
          </Button>
        </div>
        {message && (
          <p role="status" className="text-sm">
            {message}
          </p>
        )}
      </form>
    </details>
  );
}
