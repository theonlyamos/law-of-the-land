"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { OrganizationForm } from "./organization-form";
import { StepUpDialog } from "@/components/admin/step-up-dialog";
import { secondaryButtonClass } from "@/components/admin/form-styles";
export function OrganizationSettings({
  organizationId,
}: {
  organizationId: Id<"organizations">;
}) {
  const data = useQuery(api.organizations.getOrganizationWorkspace, {
      organizationId,
    }),
    archive = useMutation(api.organizations.archive),
    restore = useMutation(api.organizations.restore);
  const router = useRouter(),
    [risk, setRisk] = useState<string | null>(null),
    [message, setMessage] = useState("");
  if (!data) return <p role="status">Loading organization…</p>;
  const org = data.organization,
    archived = org.status === "archived";
  return (
    <div className="space-y-7">
      <header>
        <h1 className="text-3xl font-semibold">Organization settings</h1>
        <p className="mt-3 text-sm">
          {org.name} · {archived ? "Archived" : "Active"}
        </p>
      </header>
      {org.needsOwner && (
        <p className="border-l-4 border-amber-700 p-4 text-sm">
          This organization needs an owner. Ask your platform administrator to
          assign an existing manager.
        </p>
      )}
      {data.canManageMembers ? (
        <OrganizationForm
          organizationId={organizationId}
          initial={org}
          onSaved={() => {
            setMessage("Organization saved.");
            router.refresh();
          }}
        />
      ) : (
        <dl className="grid gap-3 border-y py-5">
          <dt className="font-semibold">Organization type</dt>
          <dd>{org.class.replaceAll("_", " ")}</dd>
          <dt className="font-semibold">Website</dt>
          <dd>
            {org.website ? (
              <a className="underline" href={org.website}>
                {org.website}
              </a>
            ) : (
              "Not provided"
            )}
          </dd>
        </dl>
      )}
      {message && <p role="status">{message}</p>}
      {!archived && (
        <p className="text-sm">
          Jurisdiction names, visibility, and scope are managed under{" "}
          <Link
            className="underline"
            href={`/organizations/${organizationId}/jurisdictions`}
          >
            Jurisdictions
          </Link>
          .
        </p>
      )}
      {org.isOwner && (
        <section className="max-w-2xl space-y-4 border-t pt-6">
          <h2 className="text-xl font-semibold">
            {archived ? "Restore organization" : "Archive organization"}
          </h2>
          <p className="text-sm leading-6">
            {archived
              ? "Restoring makes enabled public jurisdictions discoverable again. Chat widgets remain disabled until you enable each one."
              : "Archiving suspends member access, public discovery, and all chat widgets. Pending invitations are revoked. Documents and memberships are retained."}
          </p>
          <button
            className={secondaryButtonClass}
            onClick={() => setRisk(`org_${crypto.randomUUID()}`)}
          >
            {archived ? "Restore organization" : "Archive organization"}
          </button>
        </section>
      )}
      {risk && (
        <StepUpDialog
          open
          title={archived ? "Restore organization" : "Archive organization"}
          description={
            archived
              ? "Public jurisdictions become discoverable again; widgets stay disabled."
              : "This suspends all organization jurisdictions and widgets."
          }
          submitLabel={archived ? "Restore" : "Archive"}
          targetId={organizationId}
          idempotencyKey={risk}
          stepUpAction={
            archived ? "organization_restore" : "organization_archive"
          }
          confirmationPhrase={`${archived ? "RESTORE" : "ARCHIVE"} ${organizationId}`}
          onClose={() => setRisk(null)}
          onConfirmed={async (input) => {
            await (archived ? restore : archive)({
              organizationId,
              idempotencyKey: risk,
              confirmation: input.confirmation ?? "",
            });
            setRisk(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
