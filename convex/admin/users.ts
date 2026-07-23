import { paginationOptsValidator, type PaginationResult } from "convex/server";
import { v } from "convex/values";
import { components } from "../_generated/api";
import { query } from "../_generated/server";
import { parseAdminRoles } from "../lib/adminPermissions";
import { requireEnabledAdminPermission } from "./featureFlags";

const MAX_PAGE_SIZE = 50;

const userRowValidator = v.object({
  id: v.string(),
  name: v.string(),
  email: v.string(),
  emailVerified: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
  roles: v.array(v.string()),
  banned: v.boolean(),
  twoFactorEnabled: v.boolean(),
});

const sessionRowValidator = v.object({
  id: v.string(),
  userId: v.string(),
  expiresAt: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
  isImpersonated: v.boolean(),
});

const userSearchValidator = v.union(
  v.object({ kind: v.literal("email"), value: v.string() }),
  v.object({ kind: v.literal("user_id"), value: v.string() }),
);

const userPageValidator = v.object({
  page: v.array(userRowValidator),
  isDone: v.boolean(),
  continueCursor: v.string(),
});

const sessionPageValidator = v.object({
  page: v.array(sessionRowValidator),
  isDone: v.boolean(),
  continueCursor: v.string(),
});

type AuthDocument = Record<string, unknown>;

function normalizedPagination(paginationOpts: {
  numItems: number;
  cursor: string | null;
}) {
  if (
    !Number.isInteger(paginationOpts.numItems) ||
    paginationOpts.numItems < 1
  ) {
    throw new Error("INVALID_ADMIN_PAGINATION");
  }
  return {
    numItems: Math.min(paginationOpts.numItems, MAX_PAGE_SIZE),
    cursor: paginationOpts.cursor,
    maximumRowsRead: MAX_PAGE_SIZE + 1,
  };
}

function requiredString(document: AuthDocument, field: string): string {
  const value = document[field];
  if (typeof value !== "string") {
    throw new Error("INVALID_AUTH_COMPONENT_DATA");
  }
  return value;
}

function requiredNumber(document: AuthDocument, field: string): number {
  const value = document[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("INVALID_AUTH_COMPONENT_DATA");
  }
  return value;
}

function requiredBoolean(document: AuthDocument, field: string): boolean {
  const value = document[field];
  if (typeof value !== "boolean") {
    throw new Error("INVALID_AUTH_COMPONENT_DATA");
  }
  return value;
}

function userWhere(search?: { kind: "email" | "user_id"; value: string }) {
  if (!search) {
    return undefined;
  }
  if (!search.value.trim()) {
    throw new Error("INVALID_ADMIN_FILTER");
  }
  if (search.kind === "user_id") {
    if (search.value.trim() !== search.value) {
      throw new Error("INVALID_ADMIN_FILTER");
    }
    return [{ field: "_id", operator: "eq" as const, value: search.value }];
  }
  return [
    {
      field: "email",
      operator: "eq" as const,
      value: search.value.trim().toLowerCase(),
    },
  ];
}

export const list = query({
  args: {
    paginationOpts: paginationOptsValidator,
    search: v.optional(userSearchValidator),
  },
  returns: userPageValidator,
  handler: async (ctx, args) => {
    await requireEnabledAdminPermission(ctx, "user", "read");

    const result = (await ctx.runQuery(
      components.betterAuth.adapter.findMany,
      {
        model: "user",
        where: userWhere(args.search),
        select: [
          "id",
          "name",
          "email",
          "emailVerified",
          "createdAt",
          "updatedAt",
          "role",
          "banned",
          "twoFactorEnabled",
        ],
        sortBy: { field: "createdAt", direction: "desc" },
        paginationOpts: normalizedPagination(args.paginationOpts),
      },
    )) as PaginationResult<AuthDocument>;

    return {
      page: result.page.map((user) => ({
        id: requiredString(user, "_id"),
        name: requiredString(user, "name"),
        email: requiredString(user, "email"),
        emailVerified: requiredBoolean(user, "emailVerified"),
        createdAt: requiredNumber(user, "createdAt"),
        updatedAt: requiredNumber(user, "updatedAt"),
        roles: parseAdminRoles(user.role),
        banned: user.banned === true,
        twoFactorEnabled: user.twoFactorEnabled === true,
      })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const listSessions = query({
  args: {
    userId: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: sessionPageValidator,
  handler: async (ctx, args) => {
    await requireEnabledAdminPermission(ctx, "session", "revoke");
    if (!args.userId || args.userId.trim() !== args.userId) {
      throw new Error("INVALID_ADMIN_FILTER");
    }

    const result = (await ctx.runQuery(
      components.betterAuth.adapter.findMany,
      {
        model: "session",
        where: [{ field: "userId", operator: "eq", value: args.userId }],
        select: [
          "id",
          "userId",
          "expiresAt",
          "createdAt",
          "updatedAt",
          "impersonatedBy",
        ],
        sortBy: { field: "createdAt", direction: "desc" },
        paginationOpts: normalizedPagination(args.paginationOpts),
      },
    )) as PaginationResult<AuthDocument>;

    return {
      page: result.page.map((session) => ({
        id: requiredString(session, "_id"),
        userId: requiredString(session, "userId"),
        expiresAt: requiredNumber(session, "expiresAt"),
        createdAt: requiredNumber(session, "createdAt"),
        updatedAt: requiredNumber(session, "updatedAt"),
        isImpersonated: typeof session.impersonatedBy === "string",
      })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});
