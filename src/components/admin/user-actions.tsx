"use client";

import { api } from "../../../convex/_generated/api";
import { ADMIN_ROLES, type AdminRole } from "../../../convex/lib/adminPermissions";
import { useMutation } from "convex/react";
import { useMemo, useState } from "react";
import { PermissionBoundary } from "./permission-boundary";
import { StepUpDialog } from "./step-up-dialog";

type UserAction =
  | "ban"
  | "unban"
  | "resend"
  | "roles"
  | "impersonate"
  | "delete"
  | "revoke_all"
  | { kind: "revoke"; sessionId: string };

type UserActionRecord = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  banned: boolean;
  roles: string[];
};

type SessionActionRecord = {
  id: string;
  isImpersonated: boolean;
};

const ROLE_LABELS: Record<AdminRole, string> = {
  super_admin: "Super administrator",
  content_manager: "Content manager",
  content_reviewer: "Content reviewer",
  support_agent: "Support agent",
  billing_manager: "Billing manager",
  auditor: "Auditor",
};

function actionKey(action: UserAction | null) {
  if (!action) return "";
  return typeof action === "string" ? action : `${action.kind}:${action.sessionId}`;
}

function newIdempotencyKey() {
  return crypto.randomUUID();
}

export function UserActions({
  user,
  sessions,
}: {
  user: UserActionRecord;
  sessions: SessionActionRecord[];
}) {
  const banUser = useMutation(api.admin.users.banUser);
  const unbanUser = useMutation(api.admin.users.unbanUser);
  const resendVerification = useMutation(api.admin.users.resendVerification);
  const assignRoles = useMutation(api.admin.users.assignRoles);
  const startImpersonation = useMutation(api.admin.users.startImpersonation);
  const queueUserDeletion = useMutation(api.admin.users.queueUserDeletion);
  const revokeSession = useMutation(api.admin.users.revokeSession);
  const revokeAllSessions = useMutation(api.admin.users.revokeAllSessions);
  const [activeAction, setActiveAction] = useState<UserAction | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [selectedRoles, setSelectedRoles] = useState<AdminRole[]>(
    user.roles.filter((role): role is AdminRole =>
      ADMIN_ROLES.includes(role as AdminRole),
    ),
  );
  const [feedback, setFeedback] = useState("");

  const dialog = useMemo(() => {
    if (!activeAction) return null;
    if (typeof activeAction === "object") {
      return {
        title: "Revoke this session?",
        description:
          "The device will need to sign in again. No session credential is displayed or returned.",
        submitLabel: "Revoke session",
        confirmationPhrase: `REVOKE ${activeAction.sessionId}`,
      };
    }
    switch (activeAction) {
      case "ban":
        return {
          title: "Suspend this user?",
          description:
            "Active sessions will be revoked and the account will be unable to sign in.",
          submitLabel: "Suspend user",
          confirmationPhrase: `BAN ${user.id}`,
        };
      case "unban":
        return {
          title: "Restore account access?",
          description: "The user will be allowed to sign in again.",
          submitLabel: "Restore account access",
        };
      case "resend":
        return {
          title: "Queue another verification email?",
          description:
            "Delivery is rate-limited and recorded in the administrative audit trail.",
          submitLabel: "Queue verification email",
        };
      case "roles":
        return {
          title: "Assign administrative roles?",
          description:
            "This changes site-wide authority. Your password confirmation is bound only to this exact role change.",
          submitLabel: "Verify and assign roles",
          stepUpAction: "roles_assign",
        };
      case "impersonate":
        return {
          title: "View the site as this user?",
          description:
            "A visible, read-only administrative session lasts no longer than 15 minutes. Administrator accounts cannot be targeted.",
          submitLabel: "Verify and impersonate user",
          stepUpAction: "impersonation_start",
        };
      case "delete":
        return {
          title: "Queue user deletion?",
          description:
            "Deletion is delayed for seven days so the request can be reviewed and recovered before execution.",
          submitLabel: "Verify and queue deletion",
          stepUpAction: "user_deletion_queue",
          confirmationPhrase: `DELETE ${user.id}`,
        };
      case "revoke_all":
        return {
          title: "Revoke every session?",
          description: "Every device will need to sign in again.",
          submitLabel: "Revoke all sessions",
          confirmationPhrase: `REVOKE ALL ${user.id}`,
        };
    }
  }, [activeAction, user.id]);

  function openAction(action: UserAction) {
    setFeedback("");
    setIdempotencyKey(newIdempotencyKey());
    setActiveAction(action);
  }

  async function runAction(input: {
    reason: string;
    confirmation?: string;
  }) {
    if (!activeAction || !idempotencyKey) return;
    const common = { reason: input.reason, idempotencyKey };
    let result: {
      status: "succeeded" | "failed" | "queued" | "authorized";
    };
    if (typeof activeAction === "object") {
      result = await revokeSession({
        ...common,
        userId: user.id,
        sessionId: activeAction.sessionId,
        confirmation: input.confirmation ?? "",
      });
    } else {
      switch (activeAction) {
        case "ban":
          result = await banUser({
            ...common,
            userId: user.id,
            confirmation: input.confirmation ?? "",
          });
          break;
        case "unban":
          result = await unbanUser({ ...common, userId: user.id });
          break;
        case "resend":
          result = await resendVerification({ ...common, userId: user.id });
          break;
        case "roles":
          result = await assignRoles({
            ...common,
            userId: user.id,
            roles: selectedRoles,
          });
          break;
        case "impersonate": {
          result = await startImpersonation({ ...common, userId: user.id });
          if (result.status === "authorized") {
            const response = await fetch("/api/auth/admin/impersonate-user", {
              method: "POST",
              credentials: "same-origin",
              headers: {
                "content-type": "application/json",
                "x-admin-operation-key": idempotencyKey,
              },
              body: JSON.stringify({ userId: user.id }),
            });
            if (!response.ok) {
              throw new Error(
                "The impersonation session could not be started. No access was changed.",
              );
            }
            window.location.assign("/");
          }
          break;
        }
        case "delete":
          result = await queueUserDeletion({
            ...common,
            userId: user.id,
            confirmation: input.confirmation ?? "",
          });
          break;
        case "revoke_all":
          result = await revokeAllSessions({
            ...common,
            userId: user.id,
            confirmation: input.confirmation ?? "",
          });
          break;
      }
    }
    if (result.status === "failed") {
      throw new Error(
        "The service rejected the operation. No successful change was recorded.",
      );
    }
    setFeedback(
      result.status === "queued"
        ? "The request is queued for controlled processing."
        : "The administrative action completed.",
    );
  }

  const actionButton =
    "min-h-11 border border-[oklch(58%_0.04_252)] bg-[oklch(97%_0.012_82)] px-4 py-2 text-left text-sm font-semibold transition-colors duration-150 hover:bg-[oklch(91%_0.025_79)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700";

  return (
    <section className="mt-10 border-t-2 border-[oklch(35%_0.055_252)] pt-7" aria-labelledby="support-actions-heading">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,0.72fr)_minmax(20rem,1.28fr)]">
        <header>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[oklch(45%_0.06_65)]">
            Controlled operations
          </p>
          <h2 id="support-actions-heading" className="mt-2 text-2xl font-semibold tracking-[-0.035em]">
            User actions
          </h2>
          <p className="mt-3 max-w-[48ch] text-sm leading-6 text-[oklch(39%_0.035_252)]">
            Every change requires a reason, an idempotency key, and an immutable audit record.
          </p>
        </header>

        <div className="grid content-start gap-3 @container">
          <PermissionBoundary resource="user" action="support">
            {!user.emailVerified ? (
              <button className={actionButton} type="button" onClick={() => openAction("resend")}>
                Resend verification email
              </button>
            ) : null}
            <button className={actionButton} type="button" onClick={() => openAction("delete")}>
              Queue user deletion
            </button>
          </PermissionBoundary>
          <PermissionBoundary resource="user" action="ban">
            <button
              className={actionButton}
              type="button"
              onClick={() => openAction(user.banned ? "unban" : "ban")}
            >
              {user.banned ? "Restore account access" : "Suspend user"}
            </button>
          </PermissionBoundary>
          <PermissionBoundary resource="user" action="set_role">
            <fieldset className="border-y border-[oklch(72%_0.03_78)] py-4">
              <legend className="px-1 text-sm font-semibold">Administrative roles</legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {ADMIN_ROLES.map((role) => (
                  <label key={role} className="flex min-h-11 items-center gap-3 text-sm">
                    <input
                      type="checkbox"
                      checked={selectedRoles.includes(role)}
                      onChange={(event) =>
                        setSelectedRoles((current) =>
                          event.target.checked
                            ? [...current, role]
                            : current.filter((candidate) => candidate !== role),
                        )
                      }
                      className="h-5 w-5 accent-[oklch(42%_0.08_252)]"
                    />
                    {ROLE_LABELS[role]}
                  </label>
                ))}
              </div>
              <button className={`${actionButton} mt-3`} type="button" onClick={() => openAction("roles")}>
                Assign roles
              </button>
            </fieldset>
          </PermissionBoundary>
          <PermissionBoundary resource="user" action="impersonate">
            <button className={actionButton} type="button" onClick={() => openAction("impersonate")}>
              Impersonate user
            </button>
          </PermissionBoundary>
          <PermissionBoundary resource="session" action="revoke">
            <button className={actionButton} type="button" onClick={() => openAction("revoke_all")}>
              Revoke all sessions
            </button>
            {sessions.map((session) => (
              <button
                key={session.id}
                className={actionButton}
                type="button"
                onClick={() => openAction({ kind: "revoke", sessionId: session.id })}
              >
                Revoke session {session.id}
              </button>
            ))}
          </PermissionBoundary>
        </div>
      </div>

      {feedback ? (
        <p role="status" className="mt-5 border-y border-[oklch(63%_0.07_145)] bg-[oklch(93%_0.035_145)] px-4 py-3 text-sm text-[oklch(34%_0.07_145)]">
          {feedback}
        </p>
      ) : null}

      {dialog ? (
        <StepUpDialog
          open
          title={dialog.title}
          description={dialog.description}
          submitLabel={dialog.submitLabel}
          targetId={user.id}
          idempotencyKey={idempotencyKey}
          stepUpAction={dialog.stepUpAction}
          confirmationPhrase={dialog.confirmationPhrase}
          onClose={() => setActiveAction(null)}
          onConfirmed={runAction}
        />
      ) : null}
    </section>
  );
}
