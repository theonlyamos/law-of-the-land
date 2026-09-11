"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { MAX_SCOPE_LINKS } from "@/convex/lib/jurisdictionDomain";
import type { Id } from "@/convex/_generated/dataModel";
import { DataTable } from "@/components/admin/data-table";
import { StepUpDialog } from "@/components/admin/step-up-dialog";
import {
  fieldClass,
  labelClass,
  buttonClass,
  secondaryButtonClass,
} from "@/components/admin/form-styles";
type Target = {
  organizationId: Id<"organizations">;
  jurisdictionId: Id<"jurisdictions">;
};
type Geography = { id: Id<"jurisdictions">; name: string };
export function OrganizationJurisdictions({
  organizationId,
}: {
  organizationId: Id<"organizations">;
}) {
  const workspace = useQuery(api.organizations.getOrganizationWorkspace, {
      organizationId,
    }),
    search = useSearchParams(),
    router = useRouter();
  const status = search.get("status") === "archived" ? "archived" : "current",
    cursor = search.get("cursor");
  const data = useQuery(api.organizationJurisdictions.list, {
    organizationId,
    status,
    paginationOpts: { numItems: 20, cursor },
  });
  const [creating, setCreating] = useState(false);
  return (
    <div className="space-y-7">
      <header className="flex flex-wrap justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold">Jurisdictions</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6">
            Keep separate policy libraries for teams, campuses, or areas of
            responsibility. A chat uses one selected jurisdiction.
          </p>
        </div>
        {workspace?.canManage && (
          <button
            className={buttonClass}
            onClick={() => setCreating((v) => !v)}
          >
            {creating ? "Cancel" : "Create jurisdiction"}
          </button>
        )}
      </header>
      {creating && (
        <JurisdictionForm
          organizationId={organizationId}
          onSaved={(id) =>
            router.push(
              `/organizations/${organizationId}/jurisdictions/${id}/resources`,
            )
          }
        />
      )}
      <DataTable
        ariaLabel="Organization jurisdictions"
        filterSubmitLabel="Apply filters"
        basePath={`/organizations/${organizationId}/jurisdictions`}
        columns={[
          { key: "name", label: "Jurisdiction" },
          { key: "status", label: "Status" },
          { key: "visibility", label: "Visibility" },
          { key: "library", label: "Library" },
          { key: "widget", label: "Chat widget" },
        ]}
        rows={(data?.page ?? []).map((row) => ({
          id: row.id,
          cells: {
            name: (
              <Link
                className="font-semibold underline underline-offset-4"
                href={`/organizations/${organizationId}/jurisdictions/${row.id}/${row.status === "archived" ? "settings" : "resources"}`}
              >
                {row.name}
              </Link>
            ),
            status: row.status,
            visibility: row.visibility === "public" ? "Public" : "Private",
            library: row.libraryState.replaceAll("_", " "),
            widget: row.widgetEnabled ? "Enabled" : "Disabled",
          },
        }))}
        filters={[
          {
            name: "status",
            label: "Status",
            value: status,
            options: [
              { value: "current", label: "Current" },
              { value: "archived", label: "Archived" },
            ],
          },
        ]}
        currentCursor={cursor}
        previousCursors={search.getAll("history")}
        nextCursor={data?.continueCursor ?? ""}
        isDone={data?.isDone ?? true}
        state={data ? "ready" : "loading"}
        emptyMessage="No jurisdictions here yet. Create your first jurisdiction to start adding documents. Its library is set up automatically."
      />
    </div>
  );
}
function JurisdictionForm({
  organizationId,
  initial,
  onSaved,
}: {
  organizationId: Id<"organizations">;
  initial?: { id: Id<"jurisdictions">; name: string; geographies: Geography[] };
  onSaved: (id: Id<"jurisdictions">) => void;
}) {
  const create = useMutation(api.organizationJurisdictions.create),
    update = useMutation(api.organizationJurisdictions.update);
  const [selected, setSelected] = useState<Geography[]>(
      initial?.geographies ?? [],
    ),
    [scopeOpen, setScopeOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const request = useRef<{ input: string; key: string } | null>(null);
  return (
    <form
      className="grid max-w-3xl gap-5 border border-[oklch(74%_0.028_78)] bg-[oklch(96%_0.014_82)] p-5 sm:p-7"
      onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget),
          input = {
            organizationId,
            name: String(form.get("name")).trim(),
            scopeMode: selected.length
              ? ("linked_geographies" as const)
              : ("global" as const),
            geographicJurisdictionIds: selected.map((row) => row.id),
          };
        const serialized = JSON.stringify(input);
        if (request.current?.input !== serialized)
          request.current = {
            input: serialized,
            key: `jur_${crypto.randomUUID()}`,
          };
        setBusy(true);
        setError("");
        try {
          if (initial) {
            await update({
              ...input,
              jurisdictionId: initial.id,
              reason: String(form.get("reason")),
            });
            onSaved(initial.id);
          } else
            onSaved(
              await create({ ...input, idempotencyKey: request.current.key }),
            );
        } catch {
          setError(
            `Could not save this jurisdiction. Use a unique name and up to ${MAX_SCOPE_LINKS} eligible geographic libraries. An organization can have up to twenty current jurisdictions.`,
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className={labelClass}>
        Jurisdiction name
        <input
          name="name"
          required
          maxLength={300}
          defaultValue={initial?.name}
          placeholder="For example, Employment policies"
          className={fieldClass}
        />
      </label>
      <p className="text-sm">
        New jurisdictions start private. Library setup runs automatically.
      </p>
      <details onToggle={(event) => setScopeOpen(event.currentTarget.open)}>
        <summary className="min-h-11 cursor-pointer py-3 font-semibold">
          Geographic scope (optional)
        </summary>
        <p className="mb-4 text-sm">
          Normal research chat can also use these geographic libraries. Embedded
          chat uses only this jurisdiction's documents.
        </p>
        {scopeOpen && (
          <GeographicSelection
            organizationId={organizationId}
            selected={selected}
            onChange={setSelected}
          />
        )}
      </details>
      {selected.length > 0 && (
        <p className="text-sm">
          Linked: {selected.map((row) => row.name).join(", ")}
        </p>
      )}
      {initial && (
        <label className={labelClass}>
          Reason for change
          <input
            name="reason"
            required
            minLength={3}
            maxLength={500}
            className={fieldClass}
          />
        </label>
      )}
      <button disabled={busy} className={buttonClass}>
        {busy
          ? "Saving…"
          : initial
            ? "Save jurisdiction"
            : "Create jurisdiction"}
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-800">
          {error}
        </p>
      )}
    </form>
  );
}
function GeographicSelection({
  organizationId,
  selected,
  onChange,
}: {
  organizationId: Id<"organizations">;
  selected: Geography[];
  onChange: (rows: Geography[]) => void;
}) {
  const [input, setInput] = useState(""),
    [query, setQuery] = useState("");
  const { results, status, loadMore } = usePaginatedQuery(
    api.organizationJurisdictions.listGeographicOptions,
    { organizationId, query: query || undefined },
    { initialNumItems: 20 },
  );
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <label className={`${labelClass} flex-1`}>
          Find geography
          <input
            className={fieldClass}
            value={input}
            maxLength={100}
            onChange={(e) => setInput(e.target.value)}
          />
        </label>
        <button
          type="button"
          className={`${secondaryButtonClass} self-end`}
          onClick={() => setQuery(input.trim())}
        >
          Search
        </button>
      </div>
      {selected.map((row) => (
        <button
          key={row.id}
          type="button"
          className={secondaryButtonClass}
          onClick={() =>
            onChange(selected.filter((item) => item.id !== row.id))
          }
        >
          Remove {row.name}
        </button>
      ))}
      <div className="max-h-64 overflow-y-auto border p-3">
        {results.map((row) => (
          <label
            className="flex min-h-11 items-center gap-3 text-sm"
            key={row.id}
          >
            <input
              type="checkbox"
              checked={selected.some((item) => item.id === row.id)}
              disabled={
                selected.length >= MAX_SCOPE_LINKS &&
                !selected.some((item) => item.id === row.id)
              }
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...selected, row]
                    : selected.filter((item) => item.id !== row.id),
                )
              }
            />
            {row.name}
          </label>
        ))}
        {status === "LoadingFirstPage" && (
          <p role="status">Loading geographies…</p>
        )}
      </div>
      {status === "CanLoadMore" && (
        <button
          type="button"
          className={secondaryButtonClass}
          onClick={() => loadMore(20)}
        >
          More geographies
        </button>
      )}
    </div>
  );
}
export function JurisdictionSettings(target: Target) {
  const data = useQuery(api.organizationJurisdictions.get, target),
    setVisibility = useMutation(api.organizationJurisdictions.setVisibility),
    enable = useMutation(api.organizationJurisdictions.enable),
    archive = useMutation(api.organizationJurisdictions.archive),
    restore = useMutation(api.organizationJurisdictions.restore),
    retry = useMutation(api.organizationJurisdictions.retrySetup);
  const [risk, setRisk] = useState<{
      key: string;
      visibility: "public" | "members";
    } | null>(null),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  if (!data) return <p role="status">Loading jurisdiction…</p>;
  const jur = data.jurisdiction,
    archived = jur.status === "archived";
  return (
    <div className="space-y-7">
      <h1 className="text-3xl font-semibold">Jurisdiction settings</h1>
      <p>
        {jur.name} · {jur.status} ·{" "}
        {jur.visibility === "public" ? "Public" : "Private"}
      </p>
      {data.canManage && !archived && (
        <JurisdictionForm
          organizationId={target.organizationId}
          initial={{
            id: jur.id,
            name: jur.name,
            geographies: data.geographicJurisdictions,
          }}
          onSaved={() => setMessage("Jurisdiction saved.")}
        />
      )}
      <p className="max-w-2xl text-sm leading-6">
        Public jurisdictions are discoverable by all visitors. Private
        jurisdictions are available to organization members. An enabled chat
        widget also lets visitors on approved websites ask about published
        documents.
      </p>
      {data.canManage && !archived && (
        <button
          className={secondaryButtonClass}
          onClick={() =>
            setRisk({
              key: `visibility_${crypto.randomUUID()}`,
              visibility: jur.visibility === "public" ? "members" : "public",
            })
          }
        >
          {jur.visibility === "public" ? "Make private" : "Make public"}
        </button>
      )}
      <section className="max-w-2xl space-y-4 border-t pt-5">
        <h2 className="text-xl font-semibold">Library and availability</h2>
        <p className="text-sm">
          {jur.libraryState === "setting_up"
            ? "Your document library is being set up. You can stay on this page; its status updates automatically."
            : jur.libraryState === "ready"
              ? "Library ready. Enable the jurisdiction to publish and research its documents."
              : "Library setup needs attention. Retry safely or contact your platform administrator."}
        </p>
        {data.canManage && (
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget),
                action = (
                  event.nativeEvent as SubmitEvent
                ).submitter?.getAttribute("value");
              setBusy(true);
              try {
                if (action === "retry")
                  await retry({
                    ...target,
                    idempotencyKey: `setup_${crypto.randomUUID()}`,
                  });
                else
                  await (
                    action === "archive"
                      ? archive
                      : action === "restore"
                        ? restore
                        : enable
                  )({ ...target, reason: String(form.get("reason")) });
                setMessage("Jurisdiction updated.");
              } catch {
                setMessage(
                  "This action could not complete safely. Before archiving, unpublish and archive documents and remove linked geographies. Setup recovery may require your platform administrator.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className={labelClass}>
              Reason
              <input
                name="reason"
                required
                minLength={3}
                maxLength={500}
                className={fieldClass}
              />
            </label>
            <div className="flex flex-wrap gap-3">
              {archived ? (
                <button className={buttonClass} value="restore" disabled={busy}>
                  Restore as draft
                </button>
              ) : (
                <>
                  {jur.status === "draft" && (
                    <button
                      className={buttonClass}
                      value="enable"
                      disabled={busy || jur.libraryState !== "ready"}
                    >
                      Enable jurisdiction
                    </button>
                  )}
                  <button
                    className={secondaryButtonClass}
                    value="archive"
                    disabled={busy}
                  >
                    Archive jurisdiction
                  </button>
                  {jur.libraryState === "needs_attention" && (
                    <button
                      className={secondaryButtonClass}
                      value="retry"
                      disabled={busy}
                    >
                      Retry setup safely
                    </button>
                  )}
                </>
              )}
            </div>
          </form>
        )}
      </section>
      {message && <p role="status">{message}</p>}
      {risk && (
        <StepUpDialog
          open
          title={
            risk.visibility === "public"
              ? "Make jurisdiction public"
              : "Make jurisdiction private"
          }
          description="Published documents become available to the selected audience. An enabled chat widget remains available on approved websites."
          submitLabel="Change visibility"
          cancelLabel="Keep current visibility"
          targetId={target.jurisdictionId}
          idempotencyKey={risk.key}
          stepUpAction="organization_visibility"
          confirmationPhrase={`${risk.visibility === "public" ? "PUBLIC" : "PRIVATE"} ${target.jurisdictionId}`}
          onClose={() => setRisk(null)}
          onConfirmed={async (input) => {
            await setVisibility({
              ...target,
              visibility: risk.visibility,
              confirmation: input.confirmation ?? "",
              idempotencyKey: risk.key,
            });
            setRisk(null);
          }}
        />
      )}
    </div>
  );
}
