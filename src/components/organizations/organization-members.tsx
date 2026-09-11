"use client";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { StepUpDialog } from "@/components/admin/step-up-dialog";
import { DataTable } from "@/components/admin/data-table";
import {
  fieldClass,
  labelClass,
  buttonClass,
  secondaryButtonClass,
} from "@/components/admin/form-styles";
type Role = "member" | "manager" | "reviewer";
const roles: Role[] = ["member", "manager", "reviewer"];
export function RecipientInvitations({
  invitationId,
}: {
  invitationId: string | null;
}) {
  const { results, status, loadMore } = usePaginatedQuery(
    api.organizationMembers.listMyInvitations,
    {},
    { initialNumItems: 20 },
  );
  const selected = useQuery(
    api.organizationMembers.getMyInvitation,
    invitationId ? { invitationId } : "skip",
  );
  const accept = useMutation(api.organizationMembers.acceptInvitation),
    decline = useMutation(api.organizationMembers.declineInvitation);
  const router = useRouter(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const rows = selected
    ? [selected, ...results.filter((row) => row.id !== selected.id)]
    : results;
  if (!rows.length && !invitationId) return null;
  return (
    <section
      className="space-y-4 border-l-4 border-amber-700 bg-[oklch(94%_0.02_82)] p-5"
      aria-label="Organization invitations"
    >
      <h2 className="text-xl font-semibold">Invitations</h2>
      {invitationId && selected === null && (
        <p role="status">
          This invitation is unavailable. Sign in with the verified email
          address it was sent to.
        </p>
      )}
      {rows.map((row) => (
        <div
          key={row.id}
          className="flex flex-wrap items-center justify-between gap-4 border-b py-3"
        >
          <p>
            <strong>{row.organizationName}</strong> · {row.role}
            <span className="block text-sm">
              Expires {new Date(row.expiresAt).toLocaleDateString()}
            </span>
          </p>
          <div className="flex gap-3">
            <button
              disabled={busy}
              className={buttonClass}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  router.push(
                    `/organizations/${await accept({ invitationId: row.id })}/jurisdictions`,
                  );
                } catch {
                  setError(
                    "This invitation could not be accepted. Verify your email and two-factor sign-in, or ask for a new invitation.",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              Accept
            </button>
            <button
              disabled={busy}
              className={secondaryButtonClass}
              onClick={async () => {
                setBusy(true);
                try {
                  await decline({ invitationId: row.id });
                } catch {
                  setError("This invitation could not be declined. Try again.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Decline
            </button>
          </div>
        </div>
      ))}
      {status === "CanLoadMore" && (
        <button className={secondaryButtonClass} onClick={() => loadMore(20)}>
          More invitations
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
export function OrganizationMembers({
  organizationId,
}: {
  organizationId: Id<"organizations">;
}) {
  const workspace = useQuery(api.organizations.getOrganizationWorkspace, {
      organizationId,
    }),
    search = useSearchParams(),
    router = useRouter();
  const cursor = search.get("cursor"),
    members = useQuery(api.organizationMembers.listMembers, {
      organizationId,
      paginationOpts: { numItems: 20, cursor },
    });
  const changeRole = useMutation(api.organizationMembers.changeRole),
    remove = useMutation(api.organizationMembers.removeMember),
    transfer = useMutation(api.organizationMembers.transferOwnership),
    leave = useMutation(api.organizationMembers.leave);
  const [risk, setRisk] = useState<{
      kind: "role" | "remove" | "transfer";
      id: Id<"organizationMemberships">;
      role: Role;
      key: string;
    } | null>(null),
    [leaving, setLeaving] = useState(false),
    [error, setError] = useState("");
  const owner = !!workspace?.canManageMembers;
  return (
    <div className="space-y-7">
      <header>
        <h1 className="text-3xl font-semibold">Members</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6">
          Managers manage jurisdictions and upload documents. Reviewers approve
          and publish documents. The owner can do both, including reviewing
          their own uploads.
        </p>
      </header>
      {owner && <OwnerInvitations organizationId={organizationId} />}
      <DataTable
        ariaLabel="Organization members"
        basePath={`/organizations/${organizationId}/members`}
        columns={[
          { key: "name", label: "Name" },
          { key: "role", label: "Role" },
          { key: "actions", label: "Actions" },
        ]}
        rows={(members?.page ?? []).map((row) => ({
          id: row.id,
          cells: {
            name: row.name,
            role: row.isOwner ? "Owner" : row.role,
            actions:
              owner && !row.isOwner ? (
                <div className="flex flex-wrap gap-2">
                  <select
                    aria-label={`Role for ${row.name}`}
                    className={fieldClass}
                    value={row.role}
                    onChange={(event) =>
                      setRisk({
                        kind: "role",
                        id: row.id,
                        role: event.target.value as Role,
                        key: `role_${crypto.randomUUID()}`,
                      })
                    }
                  >
                    {roles.map((role) => (
                      <option key={role}>{role}</option>
                    ))}
                  </select>
                  <button
                    className={secondaryButtonClass}
                    onClick={() =>
                      setRisk({
                        kind: "transfer",
                        id: row.id,
                        role: row.role,
                        key: `transfer_${crypto.randomUUID()}`,
                      })
                    }
                  >
                    Transfer ownership
                  </button>
                  <button
                    className={secondaryButtonClass}
                    onClick={() =>
                      setRisk({
                        kind: "remove",
                        id: row.id,
                        role: row.role,
                        key: `remove_${crypto.randomUUID()}`,
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
              ) : (
                "—"
              ),
          },
        }))}
        currentCursor={cursor}
        previousCursors={search.getAll("history")}
        nextCursor={members?.continueCursor ?? ""}
        isDone={members?.isDone ?? true}
        state={members ? "ready" : "loading"}
      />
      {workspace && !workspace.organization.isOwner && (
        <section className="space-y-3 border-t pt-5">
          <button
            className={secondaryButtonClass}
            onClick={() => setLeaving((v) => !v)}
          >
            Leave organization
          </button>
          {leaving && (
            <div className="space-y-3">
              <p>
                You will lose access to private jurisdictions and organization
                management.
              </p>
              <button
                className={buttonClass}
                onClick={async () => {
                  try {
                    await leave({ organizationId });
                    router.push("/organizations");
                  } catch {
                    setError(
                      "Could not leave. Your access may have changed; refresh and retry.",
                    );
                  }
                }}
              >
                Confirm leave
              </button>
            </div>
          )}
        </section>
      )}
      {error && <p role="alert">{error}</p>}
      {risk && (
        <StepUpDialog
          open
          title={
            risk.kind === "transfer"
              ? "Transfer ownership"
              : risk.kind === "remove"
                ? "Remove member"
                : "Change member role"
          }
          description={
            risk.kind === "transfer"
              ? "The selected member becomes the owner with manager and review access. You remain a manager and lose owner-only controls."
              : "Verify your password to change this member's access."
          }
          submitLabel="Confirm change"
          targetId={risk.id}
          idempotencyKey={risk.key}
          stepUpAction={
            risk.kind === "transfer"
              ? "organization_owner_transfer"
              : risk.kind === "remove"
                ? "organization_member_remove"
                : "organization_member_role"
          }
          confirmationPhrase={
            risk.kind === "role"
              ? `ROLE ${risk.id} ${risk.role}`
              : `${risk.kind === "remove" ? "REMOVE" : "TRANSFER"} ${risk.id}`
          }
          onClose={() => setRisk(null)}
          onConfirmed={async (input) => {
            const args = {
              reason: input.reason,
              organizationId,
              membershipId: risk.id,
              confirmation: input.confirmation ?? "",
              idempotencyKey: risk.key,
            };
            if (risk.kind === "role")
              await changeRole({ ...args, role: risk.role });
            else await (risk.kind === "remove" ? remove : transfer)(args);
            setRisk(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
function OwnerInvitations({
  organizationId,
}: {
  organizationId: Id<"organizations">;
}) {
  const data = useQuery(api.organizationMembers.listInvitations, {
    organizationId,
    paginationOpts: { numItems: 20, cursor: null },
  });
  const invite = useMutation(api.organizationMembers.invite),
    resend = useMutation(api.organizationMembers.resendInvitation),
    revoke = useMutation(api.organizationMembers.revokeInvitation);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  return (
    <section className="space-y-5 border border-[oklch(74%_0.028_78)] p-5">
      <h2 className="text-xl font-semibold">Invite a member</h2>
      <form
        className="flex flex-wrap items-end gap-4"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget,
            data = new FormData(form);
          setBusy(true);
          setMessage("");
          try {
            await invite({
              organizationId,
              email: String(data.get("email")),
              role: data.get("role") as Role,
            });
            form.reset();
            setMessage("Invitation created. Delivery status appears below.");
          } catch {
            setMessage(
              "Could not invite this member. Check the email and pending invitations, then retry.",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className={`${labelClass} min-w-0 flex-1`}>
          Email
          <input
            className={fieldClass}
            type="email"
            name="email"
            required
            maxLength={254}
          />
        </label>
        <label className={labelClass}>
          Role
          <select name="role" className={fieldClass}>
            {roles.map((role) => (
              <option key={role}>{role}</option>
            ))}
          </select>
        </label>
        <button className={buttonClass} disabled={busy}>
          Send invitation
        </button>
      </form>
      <p className="text-sm">
        Invitations expire after seven days. Reviewers are optional; owners can
        review and publish documents.
      </p>
      {data?.page.map((row) => (
        <div
          key={row.id}
          className="flex flex-wrap items-center justify-between gap-3 border-t pt-3"
        >
          <p className="break-all text-sm">
            {row.email} · {row.role} ·{" "}
            {row.deliveryState === "failed"
              ? "Delivery failed — resend available"
              : row.deliveryState}
          </p>
          <div className="flex gap-2">
            <button
              className={secondaryButtonClass}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await resend({ invitationId: row.id });
                  setMessage("Invitation queued again.");
                } catch {
                  setMessage(
                    "Could not resend. Wait at least one minute between sends; expired invitations must be recreated.",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              Resend
            </button>
            <button
              className={secondaryButtonClass}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await revoke({ invitationId: row.id });
                } catch {
                  setMessage(
                    "Could not revoke this invitation. Refresh and retry.",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              Revoke
            </button>
          </div>
        </div>
      ))}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </section>
  );
}
