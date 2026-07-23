import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import {
  hasRolePermission,
  type AdminRole,
} from "../lib/adminPermissions";
import {
  requireAdminPermission,
  requireCurrentAdmin,
} from "../lib/requireAdmin";
import { readAdminEnabled } from "./featureFlags";
import { adminAccessError } from "../lib/adminAccessErrors";

const adminRoleValidator = v.union(
  v.literal("super_admin"),
  v.literal("content_manager"),
  v.literal("content_reviewer"),
  v.literal("support_agent"),
  v.literal("billing_manager"),
  v.literal("auditor"),
);

const currentAdminValidator = v.object({
  userId: v.string(),
  roles: v.array(adminRoleValidator),
});

const counterKeyValidator = v.union(
  v.literal("active_users"),
  v.literal("questions_today"),
  v.literal("review_backlog"),
  v.literal("ingestion_failures"),
);

const counterValidator = v.object({
  key: counterKeyValidator,
  label: v.string(),
  value: v.union(v.number(), v.null()),
  freshness: v.literal("awaiting_aggregate"),
});

const failedJobValidator = v.object({
  id: v.string(),
  label: v.string(),
  status: v.union(v.literal("failed"), v.literal("manual_review")),
  updatedAt: v.number(),
});

const reviewItemValidator = v.object({
  id: v.string(),
  title: v.string(),
  status: v.literal("pending"),
  submittedAt: v.number(),
});

const highRiskEventValidator = v.object({
  action: v.string(),
  outcome: v.union(
    v.literal("success"),
    v.literal("failure"),
    v.literal("denied"),
  ),
  createdAt: v.number(),
});

const overviewValidator = v.object({
  counters: v.array(counterValidator),
  failedJobs: v.array(failedJobValidator),
  reviewItems: v.array(reviewItemValidator),
  highRiskEvents: v.array(highRiskEventValidator),
});

export type AdminOverviewCounter = {
  key:
    | "active_users"
    | "questions_today"
    | "review_backlog"
    | "ingestion_failures";
  label: string;
  value: number | null;
  freshness: "awaiting_aggregate";
};

export type AdminOverviewFailedJob = {
  id: string;
  label: string;
  status: "failed" | "manual_review";
  updatedAt: number;
};

export type AdminOverviewReviewItem = {
  id: string;
  title: string;
  status: "pending";
  submittedAt: number;
};

export type AdminOverviewHighRiskEvent = {
  action: string;
  outcome: "success" | "failure" | "denied";
  createdAt: number;
};

export type AdminOverviewResult = {
  counters: AdminOverviewCounter[];
  failedJobs: AdminOverviewFailedJob[];
  reviewItems: AdminOverviewReviewItem[];
  highRiskEvents: AdminOverviewHighRiskEvent[];
};

const HIGH_RISK_ACTIONS = [
  "admin.roles_changed",
  "admin.bootstrap_super_admin",
  "user.banned",
  "user.deletion_queued",
  "conversation.exported",
  "document.published",
  "document.unpublished",
  "document.rollback",
  "billing.changed",
  "operations.job_retried",
] as const;

async function requireEnabledAdmin(ctx: QueryCtx) {
  const admin = await requireCurrentAdmin(ctx);
  if (!(await readAdminEnabled(ctx))) {
    throw adminAccessError(
      "ADMIN_DISABLED",
      "Administration is not enabled",
    );
  }
  return admin;
}

async function readHighRiskEvents(
  ctx: QueryCtx,
  roles: readonly AdminRole[],
): Promise<AdminOverviewHighRiskEvent[]> {
  if (!hasRolePermission(roles, "audit", "read_masked")) {
    return [];
  }

  const pages = await Promise.all(
    HIGH_RISK_ACTIONS.map(async (action) =>
      await ctx.db
        .query("auditEvents")
        .withIndex("by_action_and_createdAt", (q) => q.eq("action", action))
        .order("desc")
        .take(10),
    ),
  );

  return pages
    .flat()
    .sort(
      (left: Doc<"auditEvents">, right: Doc<"auditEvents">) =>
        right.createdAt - left.createdAt,
    )
    .slice(0, 10)
    .map((event) => ({
      action: event.action,
      outcome: event.outcome ?? "success" as const,
      createdAt: event.createdAt,
    }));
}

export const currentAdmin = query({
  args: {},
  returns: currentAdminValidator,
  handler: async (ctx) => {
    const admin = await requireEnabledAdmin(ctx);
    return { userId: admin.userId, roles: admin.roles };
  },
});

export const get = query({
  args: {},
  returns: overviewValidator,
  handler: async (ctx): Promise<AdminOverviewResult> => {
    const admin = await requireAdminPermission(ctx, "operations", "read");
    if (!(await readAdminEnabled(ctx))) {
      throw adminAccessError(
        "ADMIN_DISABLED",
        "Administration is not enabled",
      );
    }

    // The aggregate and workflow tables arrive in later independently gated
    // slices. Keep the response contract constant without scanning source
    // tables or reporting a misleading zero as measured data.
    const counters: AdminOverviewCounter[] = [
      { key: "active_users", label: "Active users", value: null, freshness: "awaiting_aggregate" },
      { key: "questions_today", label: "Questions today", value: null, freshness: "awaiting_aggregate" },
      { key: "review_backlog", label: "Review backlog", value: null, freshness: "awaiting_aggregate" },
      { key: "ingestion_failures", label: "Ingestion failures", value: null, freshness: "awaiting_aggregate" },
    ];

    return {
      counters: [...counters],
      failedJobs: [],
      reviewItems: [],
      highRiskEvents: await readHighRiskEvents(ctx, admin.roles),
    };
  },
});
