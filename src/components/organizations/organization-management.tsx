"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { OrganizationForm } from "./organization-form";
import { DataTable } from "@/components/admin/data-table";
import { buttonClass } from "@/components/admin/form-styles";
import { RecipientInvitations } from "./organization-members";
export function OrganizationManagement() {
  const router = useRouter(),
    search = useSearchParams(),
    [creating, setCreating] = useState(false);
  const status = search.get("status") === "archived" ? "archived" : "active",
    cursor = search.get("cursor"),
    history = search.getAll("history");
  const data = useQuery(api.organizations.listMyOrganizations, {
    status,
    paginationOpts: { numItems: 20, cursor },
  });
  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-widest">Your workspace</p>
          <h1 className="mt-2 text-3xl font-semibold">Organizations</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6">
            Manage your teams and their jurisdictions. Each jurisdiction has its
            own documents, visibility, and chat widget.
          </p>
        </div>
        <button className={buttonClass} onClick={() => setCreating((v) => !v)}>
          {creating ? "Cancel" : "Create organization"}
        </button>
      </header>
      {creating && (
        <OrganizationForm
          onSaved={(id) => router.push(`/organizations/${id}/jurisdictions`)}
        />
      )}
      <RecipientInvitations invitationId={search.get("invitation")} />
      <DataTable
        ariaLabel="Your organizations"
        filterSubmitLabel="Apply filters"
        basePath="/organizations"
        columns={[
          { key: "name", label: "Organization" },
          { key: "type", label: "Type" },
          { key: "role", label: "Your role" },
        ]}
        rows={(data?.page ?? []).map((row) => ({
          id: row.id,
          cells: {
            name: (
              <Link
                className="font-semibold underline underline-offset-4"
                href={`/organizations/${row.id}/${row.status === "archived" ? "settings" : "jurisdictions"}`}
              >
                {row.name}
              </Link>
            ),
            type: row.class.replaceAll("_", " "),
            role: row.isOwner ? "Owner" : row.role,
          },
        }))}
        filters={[
          {
            name: "status",
            label: "Status",
            value: status,
            options: [
              { value: "active", label: "Active" },
              { value: "archived", label: "Archived" },
            ],
          },
        ]}
        currentCursor={cursor}
        previousCursors={history}
        nextCursor={data?.continueCursor ?? ""}
        isDone={data?.isDone ?? true}
        state={data ? "ready" : "loading"}
        emptyMessage={
          status === "archived"
            ? "No archived organizations."
            : "You haven't joined an organization yet. Create an organization to start adding jurisdictions, or accept an invitation."
        }
      />
    </div>
  );
}
